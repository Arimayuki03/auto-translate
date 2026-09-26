// @vitest-environment jsdom
/**
 * 会话取消回归：还原 / SPA 换页时，引擎应发出 cancel-translation，
 * 让 background 中止该会话的在途请求（不浪费额度/算力），而不是任其跑完。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, uninstallChromeMock } from "./helpers/chromeMock";
import { PageEngine } from "../src/content/engine";
import { Renderer } from "../src/content/renderer";
import type { Settings } from "../src/shared/types";

function makeSettings(): Settings {
  return {
    enabled: true,
    api: {
      format: "openai",
      baseUrl: "http://t",
      apiKey: "k",
      model: "m",
      temperature: 0.3,
      timeoutMs: 60000,
      maxConcurrency: 3,
    },
    translate: {
      targetLang: "zh-CN",
      displayMode: "bilingual",
      autoTranslate: true,
      autoDetectSource: true,
      minTextLength: 2,
      blockMaxChars: 1200,
      translateOnSelect: true,
      translateInput: true,
      viewportLazy: false,
      terminology: [],
    },
    sites: { whitelist: [], blacklist: [] },
    tts: { enabled: true, voice: "", rate: 0 },
    security: { encryptApiKey: false, sensitivePages: false },
    cache: { enabled: true, maxEntries: 500 },
  };
}

let sendMessage: ReturnType<typeof vi.fn>;

function mockChrome(): void {
  sendMessage = vi.fn(async (msg: { type: string; texts?: string[]; id?: string }) => {
    if (msg?.type === "translate") {
      return { id: msg.id, ok: true, results: (msg.texts ?? []).map((t) => `【译】${t}`) };
    }
    if (msg?.type === "check-cache") return { cachedCount: 0 };
    return undefined;
  });
  installChromeMock({ extra: { runtime: { sendMessage } } });
}

beforeEach(() => {
  document.body.innerHTML = `<p>Hello world paragraph.</p><p>Another paragraph here.</p>`;
  mockChrome();
});

afterEach(() => {
  uninstallChromeMock();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
}

/** 轮询等待条件成立：engine 的提取/调度是多层异步链（chunked 提取按时间片让出），
 *  固定轮数的 flush 在系统高负载下会提前返回，造成偶发失败 */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function translateCallCount(): number {
  return sendMessage.mock.calls.filter((c) => c[0]?.type === "translate").length;
}

function cancelCalls(): { type: string; sessionId: number }[] {
  return sendMessage.mock.calls
    .map((c) => c[0])
    .filter((m) => m?.type === "cancel-translation");
}

describe("会话取消", () => {
  it("translate 请求携带 sessionId（= 引擎 generation）", async () => {
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    await engine.translateAll();
    await waitFor(() => translateCallCount() > 0);
    const translateMsgs = sendMessage.mock.calls.map((c) => c[0]).filter((m) => m?.type === "translate");
    expect(translateMsgs.length).toBeGreaterThan(0);
    for (const m of translateMsgs) {
      expect(typeof m.sessionId).toBe("number");
    }
  });

  it("还原时发出 cancel-translation，sessionId 为还原前的会话", async () => {
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    await engine.translateAll();
    await waitFor(() => translateCallCount() > 0);
    expect(cancelCalls()).toHaveLength(0);

    engine.restore();
    await waitFor(() => cancelCalls().length > 0);
    const cancels = cancelCalls();
    expect(cancels.length).toBeGreaterThan(0);
    expect(typeof cancels[0].sessionId).toBe("number");
  });

  it("SPA 换页（resetForNavigation）也发出 cancel-translation", async () => {
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    await engine.translateAll();
    await waitFor(() => translateCallCount() > 0);

    engine.resetForNavigation();
    await waitFor(() => cancelCalls().length > 0);
    expect(cancelCalls().length).toBeGreaterThan(0);
  });

  it("还原后 generation 递增，新会话 sessionId 与旧会话不同", async () => {
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    await engine.translateAll();
    await flush();
    const genBefore = engine["generation"];

    engine.restore();
    expect(engine["generation"]).toBe(genBefore + 1);
  });

  it("SPA 换页打断在途翻译：state 兜底回到 done（工具条按钮不永久卡死）", async () => {
    // 在途请求永不完成：模拟翻译进行中换页（在途批次因代次作废不会走 afterGroup）
    sendMessage.mockImplementation(async (msg: { type: string; texts?: string[]; id?: string }) => {
      if (msg?.type === "check-cache") return { cachedCount: 0 };
      if (msg?.type === "translate") return new Promise(() => undefined);
      return undefined;
    });
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    await engine.translateAll();
    await waitFor(() => engine.state === "translating");

    engine.resetForNavigation();
    expect(engine.state).toBe("done");
  });

  it("还原时在途批次完成：不污染 doneTexts、无 data-it-processing 残留，重新翻译不缺段（F-2）", async () => {
    let deferredCount = 0;
    let resolveDeferred: (() => void) | undefined;
    sendMessage.mockImplementation(async (msg: { type: string; texts?: string[]; id?: string }) => {
      if (msg?.type === "check-cache") return { cachedCount: 0 };
      if (msg?.type === "translate" && deferredCount++ === 0) {
        // 第一轮翻译挂起：模拟「点还原时请求还在途」
        return new Promise((resolve) => {
          resolveDeferred = () =>
            resolve({ id: msg.id, ok: true, results: (msg.texts ?? []).map((t) => `【译】${t}`) });
        });
      }
      return { id: msg.id, ok: true, results: (msg.texts ?? []).map((t) => `【译】${t}`) };
    });

    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    await engine.translateAll(); // 返回时 fetchBatch 已发起、响应未到
    await waitFor(() => resolveDeferred !== undefined); // 高负载下异步链可能长于固定 flush
    expect(resolveDeferred).toBeTruthy();

    engine.restore(); // generation++，doneTexts 清空，清理处理标记
    resolveDeferred!(); // 在途请求此时才完成
    await flush();

    // 在途文本不得写回 doneTexts（否则重新翻译时被去重口径跳过）
    expect(engine.isSkipped("Hello world paragraph.")).toBe(false);
    // 容器上不得残留处理标记（否则 translateAll / 观察器永远跳过这些容器）
    expect(document.querySelectorAll("[data-it-processing]").length).toBe(0);

    // 重新翻译：之前在途的段落必须能再次被调度并完成
    await engine.translateAll();
    await waitFor(() => translateCallCount() >= 2); // 第二轮确实重新发起了请求
    await flush();
    expect(engine.isSkipped("Hello world paragraph.")).toBe(true);
    const translateMsgs = sendMessage.mock.calls
      .map((c) => c[0])
      .filter((m) => m?.type === "translate");
    expect(translateMsgs.length).toBeGreaterThanOrEqual(2);
  });
});
