// @vitest-environment jsdom
/**
 * translateAll 重入排队 vs 用户还原（结论2 P0-2）：
 * 在途 translateAll 期间用户还原，随后到达的「自动触发」translateAll 会被排队
 * （重入吸收在在跑任务上）；旧实现在跑任务收尾无条件重放 = 刚还原的页面被整页
 * 译回，还顺手清掉 userRestored（visibilitychange 补译从此放行）。
 * 修复后：重放必须过 userRestored 门；显式用户意图（工具条/快捷键）排队的除外。
 *
 * 「在途窗口」用挂起的 check-cache 制造：translateAll 本体 await 在
 * checkPageCacheRatio 上，跨过 restore 与排队动作仍未收尾。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageEngine } from "../src/content/engine";
import { Renderer } from "../src/content/renderer";
import type { Settings } from "../src/shared/types";

function makeSettings(): Settings {
  return {
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
      translateHover: false,
      viewportLazy: false,
      terminology: [],
    },
    sites: { whitelist: [], blacklist: [] },
    security: { encryptApiKey: false, sensitivePages: false },
    cache: { enabled: true, maxEntries: 500 },
  } as Settings;
}

let sendMessage: ReturnType<typeof vi.fn>;
let releaseCheckCache: (() => void) | undefined;
let checkCacheCalls = 0;

function mockChrome(): void {
  checkCacheCalls = 0;
  sendMessage = vi.fn(async (msg: { type: string; texts?: string[]; id?: string }) => {
    if (msg?.type === "check-cache") {
      checkCacheCalls++;
      if (checkCacheCalls === 1) {
        // 首轮缓存放像挂起：模拟「点还原时整页扫描还没收尾」
        return new Promise((resolve) => {
          releaseCheckCache = () => resolve({ cachedCount: 0 });
        });
      }
      return { cachedCount: 0 };
    }
    if (msg?.type === "translate") {
      return { id: msg.id, ok: true, results: (msg.texts ?? []).map((t) => `【译】${t}`) };
    }
    return undefined;
  });
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { sendMessage },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
  } as unknown as typeof chrome;
}

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

let engine: PageEngine;
let translateAllSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  document.body.innerHTML = `<div id="feed"><p>Hello world paragraph.</p><p>Another paragraph here.</p></div>`;
  releaseCheckCache = undefined;
  mockChrome();
  engine = new PageEngine(new Renderer("bilingual"), makeSettings());
  translateAllSpy = vi.spyOn(engine, "translateAll");
});

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

describe("在途 translateAll 收尾重放 vs 用户还原", () => {
  it("还原后到达的自动触发排队：收尾不得重放（不多一次 translateAll）", async () => {
    void engine.translateAll(); // #1 自动路径，停在挂起的 check-cache 上 → 仍在途
    await waitFor(() => checkCacheCalls > 0);

    engine.restore(); // Alt+T / 工具条还原：userRestored=true、generation++
    expect(engine.restoredByUser).toBe(true);

    void engine.translateAll(); // #2 还原之后到达的「自动触发」→ 被吸收为排队
    releaseCheckCache?.();
    await waitFor(
      () => !(engine as unknown as { translateAllRunning: boolean }).translateAllRunning
    );

    // 重放被门控拦下：只有初始 + 排队两次调用，没有第三次（重放）
    expect(translateAllSpy).toHaveBeenCalledTimes(2);
    expect(translateCallCount()).toBe(0); // #1 因代次作废未发翻译；也没被重放补上
    expect(document.querySelectorAll(".it-wrap").length).toBe(0); // 页面保持原文
    expect(engine.restoredByUser).toBe(true); // 还原意愿没被重放清掉
  });

  it("还原后用户显式再点「翻译」：排队重放必须放行", async () => {
    void engine.translateAll();
    await waitFor(() => checkCacheCalls > 0);
    engine.restore();

    void engine.translateAll(true); // 工具条/快捷键的显式意图 → 排队但标记为用户意图
    releaseCheckCache?.();
    await waitFor(() => document.querySelectorAll(".it-wrap").length > 0);

    expect(translateAllSpy.mock.calls.length).toBeGreaterThanOrEqual(3); // 重放确实执行
    expect(translateCallCount()).toBeGreaterThan(0);
    expect(engine.restoredByUser).toBe(false); // 用户的新意愿生效，抑制解除
  });

  it("无还原时排队照常重放（旧行为不回归）", async () => {
    void engine.translateAll(); // #1 在途
    await waitFor(() => checkCacheCalls > 0);
    void engine.translateAll(); // #2 排队：自动触发，但没人还原

    releaseCheckCache?.();
    await waitFor(() => translateAllSpy.mock.calls.length >= 3); // #3 = 重放
    await waitFor(() => document.querySelectorAll(".it-wrap").length > 0);
    expect(engine.restoredByUser).toBe(false);
  });
});
