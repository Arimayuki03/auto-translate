// @vitest-environment jsdom
/**
 * 调度去重回归测试：同一容器/同一文本不得因 translateAll、MutationObserver、
 * 点击扫描的重复触发而被反复调度（total 持续增加 / 重复请求）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, uninstallChromeMock } from "./helpers/chromeMock";
import { PageEngine } from "../src/content/engine";
import { PageObserver } from "../src/content/observer";
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
/** 记录所有 translate 请求的 texts（扁平化） */
function allRequestedTexts(): string[] {
  const out: string[] = [];
  for (const c of sendMessage.mock.calls) {
    const msg = c[0] as { type?: string; texts?: string[] };
    if (msg?.type === "translate" && msg.texts) out.push(...msg.texts);
  }
  return out;
}

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
  document.body.innerHTML = `
    <p>Hello world paragraph.</p>
    <p>Second paragraph content.</p>
  `;
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

/** 轮询等待条件成立（与 sessionCancel.test.ts 同惯例）：
 *  提取/调度是多层异步链，固定轮数的 flush 在系统高负载下会提前返回造成偶发失败 */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 负向断言专用（"之后不应再有新请求"）：轮询不了"不出现"的终态，只能先真实跨过
 *  观察器防抖窗口（observer.ts DEBOUNCE_MS=300ms + 余量）让 run() 有机会执行，再轮询到
 *  sendMessage 调用数连续 quietMs 无变化（在途异步全部落账），"没有新请求"的结论才有效。
 *  必须等真实时间：防抖是真实 setTimeout，这里验证的正是"时间流逝后仍无变化"。
 *  相比固定睡 550ms：落账轮询让时长自适应负载，不会在慢 CI 上提前下结论。 */
async function awaitQuietPeriod(quietMs = 150): Promise<void> {
  await new Promise((r) => setTimeout(r, 350)); // 防抖窗口 + 余量（定时器按序触发，防抖必先到期）
  let last = sendMessage.mock.calls.length;
  let stableSince = Date.now();
  const start = stableSince;
  while (Date.now() - stableSince < quietMs) {
    if (Date.now() - start > 5000) throw new Error("等待静默期超时");
    await new Promise((r) => setTimeout(r, 10));
    const now = sendMessage.mock.calls.length;
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    }
  }
}

function makeEngine(): PageEngine {
  const renderer = new Renderer("bilingual");
  renderer.setMode("bilingual");
  return new PageEngine(renderer, makeSettings());
}

describe("translateAll 去重", () => {
  it("连续调用多次 translateAll：total 不增加、请求不重复", async () => {
    const engine = makeEngine();
    await engine.translateAll();
    await waitFor(() => allRequestedTexts().length > 0); // 首轮请求确实已发出
    const totalAfter1 = engine["stats"].total;
    const reqAfter1 = allRequestedTexts().length;

    await engine.translateAll(); // 模拟 visibilitychange / SPA 换页再次触发
    await flush();
    await engine.translateAll();
    await flush();

    expect(engine["stats"].total).toBe(totalAfter1);
    expect(allRequestedTexts().length).toBe(reqAfter1);
    expect(engine["stats"].total).toBe(2); // 两段文本各计一次
  });

  it("并发触发（未 await）多次 translateAll：translateAllRunning 合并为一次，不重复计数", async () => {
    const engine = makeEngine();
    // 不 await：模拟 visibilitychange 与 SPA 换页同时触发
    void engine.translateAll();
    void engine.translateAll();
    await flush();
    await flush();
    await flush();

    expect(engine["stats"].total).toBe(2);
    expect(allRequestedTexts().length).toBe(2);
  });
});

describe("MutationObserver / 点击扫描去重", () => {
  it("Observer 连续触发：无新内容时不重复请求", async () => {
    const engine = makeEngine();
    const observer = new PageObserver(engine);
    await engine.translateAll();
    await flush();
    const reqAfter1 = allRequestedTexts().length;

    // 触发多次 childList 突变（无新可译文本）+ 点击扫描：
    // 负向断言（之后不应再有新请求），等待"无新请求落账"的静默期
    for (let i = 0; i < 3; i++) {
      document.body.appendChild(document.createElement("div"));
      document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await awaitQuietPeriod();
    }
    expect(allRequestedTexts().length).toBe(reqAfter1);
    observer.disconnect();
  });

  it("新增内容只请求一次（同一文本多个容器共享一次请求）", async () => {
    const engine = makeEngine();
    const observer = new PageObserver(engine);
    await engine.translateAll();
    await flush();
    const before = allRequestedTexts().length;

    // 同时插入两段相同文本
    const p1 = document.createElement("p");
    p1.textContent = "Brand new paragraph";
    const p2 = document.createElement("p");
    p2.textContent = "Brand new paragraph";
    document.body.append(p1, p2);
    // 等终态：新文本的翻译请求确实已发出（防抖 + 增量调度完成）
    await waitFor(() => allRequestedTexts().some((t) => t === "Brand new paragraph"));

    // 相同文本只应请求一次（同一批次内共享）
    const requested = allRequestedTexts();
    expect(requested.filter((t) => t === "Brand new paragraph").length).toBeLessThanOrEqual(1);
    expect(engine["stats"].total).toBeGreaterThan(before);
    observer.disconnect();
  });
});

describe("失败容器不重复调度", () => {
  it("翻译失败的容器不被 observer 反复调度（total 不膨胀）", async () => {
    // 让"Hello world paragraph." 翻译失败
    sendMessage.mockImplementation(async (msg: { type: string; texts?: string[]; id?: string }) => {
      if (msg?.type === "translate") {
        const failed = (msg.texts ?? []).some((t) => t.includes("Hello"));
        return failed
          ? { id: msg.id, ok: false, error: "模拟鉴权失败" }
          : { id: msg.id, ok: true, results: (msg.texts ?? []).map((t) => `【译】${t}`) };
      }
      if (msg?.type === "check-cache") return { cachedCount: 0 };
      return undefined;
    });
    const engine = makeEngine();
    const observer = new PageObserver(engine);
    await engine.translateAll();
    await flush();

    // 失败的段落标记为失败态
    const failedContainer = Array.from(document.querySelectorAll("p")).find((p) =>
      p.textContent?.includes("Hello")
    ) as HTMLElement;
    expect(engine.renderer.isFailed(failedContainer)).toBe(true);
    const totalAfter1 = engine["stats"].total;

    // 观察器多次触发扫描：失败的容器不应被重新调度（负向断言，等"无新请求落账"的静默期）
    for (let i = 0; i < 3; i++) {
      document.body.appendChild(document.createElement("span"));
      document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await awaitQuietPeriod();
    }
    expect(engine["stats"].total).toBe(totalAfter1);
    observer.disconnect();
  });
});
