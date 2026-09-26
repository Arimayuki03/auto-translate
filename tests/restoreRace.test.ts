// @vitest-environment jsdom
/**
 * 「点还原后译文反复冒出来」系列回归测试（本次修复的三处竞态）：
 * 1. 单元素还原（悬停「还原」角标）后，仍在途的旧批次完成时不得把译文回填到已还原的段落
 *    （修复前：批次令牌不存在，fetchBatch 返回后照常 fill → 译文冒回来，且统计照常累加）；
 * 2. 还原段落的文本必须从 doneTexts/pendingTexts 撤销：再悬停同段能重新出「译」角标；
 * 3. 懒观察队列中的单元被还原后，进视口触发不再翻译该段；
 * 4. 观察器兜底扫描跨 await 让出期间用户点了还原 → 扫描结果必须作废
 *    （修复前：还原后防抖到期，观察器把刚还原的整页又译回去）；
 * 5. SPA 导航的 200ms 延迟重译定时器触发时，若用户已在窗口内手动还原，必须让路。
 *
 * 结构注意：块级容器走 .it-wrap 包裹形态，译文/占位是容器的【兄弟】节点，
 * 断言用容器.closest(".it-wrap") 或文档级选择器，不能用容器.querySelector。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, uninstallChromeMock } from "./helpers/chromeMock";
import { PageEngine } from "../src/content/engine";
import { PageObserver } from "../src/content/observer";
import { Renderer } from "../src/content/renderer";
import { setupSpaNavigation } from "../src/content/navigation";
import type { Settings } from "../src/shared/types";

const LONG = "The quick brown fox jumps over the lazy dog near the river bank every morning.";
const LONG2 = "Pack my box with five dozen liquor jugs while the museum opens its doors.";

function makeSettings(): Settings {
  return {
    enabled: true,
    api: {
      format: "openai",
      baseUrl: "http://test",
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

beforeEach(() => {
  sendMessage = vi.fn(async (msg: { type: string; texts?: string[]; id?: string }) => {
    if (msg?.type === "translate") {
      return { id: msg.id, ok: true, results: (msg.texts ?? []).map((t) => `【译】${t}`) };
    }
    if (msg?.type === "check-cache") return { cachedCount: 0 };
    return undefined;
  });
  installChromeMock({ extra: { runtime: { sendMessage } } });
});

afterEach(() => {
  vi.useRealTimers();
  uninstallChromeMock();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeEngine(settings = makeSettings()) {
  const renderer = new Renderer(settings.translate.displayMode);
  renderer.setMode(settings.translate.displayMode);
  return new PageEngine(renderer, settings);
}

describe("单元素还原 vs 在途批次（批次令牌）", () => {
  it("还原该段后，同批在途请求完成不再把译文填回去", async () => {
    document.body.innerHTML = `<p id="a">${LONG}</p><p id="b">${LONG2}</p>`;
    let resolveFirst: ((r: unknown) => void) | undefined;
    let callCount = 0;
    sendMessage.mockImplementation(async (msg: { type: string; texts?: string[]; id?: string }) => {
      if (msg?.type === "check-cache") return { cachedCount: 0 };
      if (msg?.type === "translate" && callCount++ === 0) {
        // 第一批挂起：模拟「点还原时请求还在途」
        return new Promise((resolve) => {
          resolveFirst = () =>
            resolve({ id: msg.id, ok: true, results: (msg.texts ?? []).map((t) => `【译】${t}`) });
        });
      }
      return { id: msg.id, ok: true, results: (msg.texts ?? []).map((t) => `【译】${t}`) };
    });

    const engine = makeEngine();
    // 悬停单译两个段落（同一批次发出）
    engine.translateElement(document.getElementById("a")!);
    engine.translateElement(document.getElementById("b")!);
    await waitFor(() => resolveFirst !== undefined);

    // 用户在第一批在途时点「还原该段」
    const pA = document.getElementById("a")!;
    engine.restoreElement(pA);
    resolveFirst!(undefined);
    await flush();
    await flush();

    // 已还原段落不得被在途批次回填：无译文元素、无【译】文字、无已译标记
    expect(pA.closest(".it-wrap")).toBeNull();
    expect(pA.querySelectorAll(".it-translated").length).toBe(0);
    expect(document.querySelectorAll(".it-wrap > .it-translated").length).toBeLessThanOrEqual(1);
    expect(pA.textContent).not.toContain("【译】");
    expect(pA.hasAttribute("data-it-src")).toBe(false);
    // 兄弟段落（未还原）照常完成
    const pB = document.getElementById("b")!;
    expect(pB.closest(".it-wrap")).not.toBeNull();
    expect(pB.closest(".it-wrap")!.textContent).toContain("【译】");
    // 无残留处理标记
    expect(document.querySelectorAll("[data-it-processing]").length).toBe(0);
  });

  it("还原段落的文本从去重集合撤销：再次 translateElement 能重新翻译", async () => {
    document.body.innerHTML = `<p id="a">${LONG}</p>`;
    const engine = makeEngine();
    engine.translateElement(document.getElementById("a")!);
    await waitFor(() => engine.isSkipped(LONG));
    await waitFor(() => document.querySelector(".it-translated.it-done") !== null);

    engine.restoreElement(document.getElementById("a")!);
    expect(engine.isSkipped(LONG)).toBe(false);

    // 再悬停同段 →「译」角标语义：重新调度并成功渲染
    engine.translateElement(document.getElementById("a")!);
    await waitFor(() => document.querySelector(".it-translated.it-done") !== null);
    expect(engine.isSkipped(LONG)).toBe(true);
    expect(document.querySelector(".it-wrap")!.textContent).toContain("【译】");
  });

  it("懒观察队列中的单元被还原后，进视口触发不再翻译该段", async () => {
    document.body.innerHTML = `<p id="a">${LONG}</p><p id="b">${LONG2}</p>`;
    // 受控 IntersectionObserver：手动派发进视口事件
    let ioCb: ((entries: { isIntersecting: boolean; target: Element }[]) => void) | null = null;
    const OriginalIO = globalThis.IntersectionObserver;
    class MockIO {
      constructor(cb: (entries: { isIntersecting: boolean; target: Element }[]) => void) {
        ioCb = cb;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIO;

    try {
      const settings = makeSettings();
      settings.translate.viewportLazy = true;
      const engine = makeEngine(settings);
      engine.translateElement(document.body);
      await flush();
      expect(ioCb).not.toBeNull();

      // #a 在懒观察队列中时被还原
      engine.restoreElement(document.getElementById("a")!);

      // 全部进视口：#a 已撤销不得入批，#b 照常翻译
      ioCb!([
        { isIntersecting: true, target: document.getElementById("a")! },
        { isIntersecting: true, target: document.getElementById("b")! },
      ]);
      await new Promise((r) => setTimeout(r, 80)); // flushLazy 60ms 防抖
      await waitFor(() => document.querySelector(".it-translated.it-done") !== null);
      // 唯一完成的必须是 #b；#a 无任何译文结构
      const doneWrap = document.querySelector(".it-translated.it-done")!.closest(".it-wrap");
      expect(doneWrap!.querySelector("p")!.id).toBe("b");
      expect(document.getElementById("a")!.hasAttribute("data-it-src")).toBe(false);
      expect(document.getElementById("a")!.querySelectorAll(".it-translated").length).toBe(0);
    } finally {
      (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = OriginalIO;
    }
  });
});

describe("观察器扫描 vs 还原竞态", () => {
  it("防抖窗口内被还原：扫描结果作废，不再调度翻译", async () => {
    document.body.innerHTML = `<p id="a">${LONG}</p>`;
    const engine = makeEngine();
    const observer = new PageObserver(engine);
    try {
      // 首轮翻译（state 离开 off，观察器 run 才会往下走）
      await engine.translateAll();
      await waitFor(() => document.querySelector(".it-translated.it-done") !== null);
      expect(engine.state).not.toBe("off");

      // 插入新段落触发观察器（300ms 防抖），在防抖窗口内点击还原
      const p = document.createElement("p");
      p.id = "c";
      p.textContent = LONG2;
      document.body.appendChild(p);
      engine.restore();
      // 防抖到期 + 扫描执行完毕
      await new Promise((r) => setTimeout(r, 450));
      await flush();
      await flush();

      // 还原后观察器不得把页面重新译回来
      expect(engine.state).toBe("off");
      expect(engine.hasTranslated()).toBe(false);
      expect(document.querySelectorAll(".it-translated").length).toBe(0);
      expect(document.querySelectorAll("[data-it-processing]").length).toBe(0);
    } finally {
      observer.disconnect();
    }
  });
});

describe("撤销单元从后续环节完全退场（第六轮审查）", () => {
  it("占位配速让出窗口内还原：该单元不入索引、不进请求批次，占位壳一并撕掉", async () => {
    document.body.innerHTML = `<p id="a">${LONG}</p><p id="b">${LONG2}</p>`;
    // 时间片每次循环都判定为超支：每个 reserve 后真实让出一个宏任务，制造「占位进行中还原」的窗口
    let fakeNow = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => (fakeNow += 20));
    const requested: string[] = [];
    let release: (() => void) | undefined;
    sendMessage.mockImplementation((msg: { type: string; texts?: string[]; id?: string }) => {
      if (msg?.type === "check-cache") return Promise.resolve({ cachedCount: 0 });
      if (msg?.type === "translate") {
        requested.push(...(msg.texts ?? []));
        return new Promise((resolve) => {
          release = () =>
            resolve({ id: msg.id, ok: true, results: (msg.texts ?? []).map((t) => `【译】${t}`) });
        });
      }
      return Promise.resolve(undefined);
    });

    try {
      const engine = makeEngine();
      engine.translateElement(document.body); // a/b 同批调度
      await new Promise((r) => setTimeout(r, 0)); // 轮到 a 完成占位并让出

      // b 已套占位壳、尚未登记索引/发出请求：此时还原 b
      engine.restoreElement(document.getElementById("b")!);
      await new Promise((r) => setTimeout(r, 0)); // 过滤与发批完成

      expect(requested.length).toBeGreaterThan(0);
      expect(requested.some((t) => t.includes("Pack my box"))).toBe(false); // 撤销单元不消耗额度
      release!();
      await waitFor(() => document.querySelector(".it-translated.it-done") !== null);
      await flush();

      // b：占位态容器也被 clearContainer 撕壳（无 data-it-src 也须还原干净）
      const b = document.getElementById("b")!;
      expect(b.closest(".it-wrap")).toBeNull();
      expect(b.querySelectorAll(".it-translated").length).toBe(0);
      expect(b.hasAttribute("data-it-processing")).toBe(false);
      expect(document.querySelectorAll(".it-pending").length).toBe(0);
      expect(document.querySelectorAll("[data-it-processing]").length).toBe(0);
      // a 照常完成
      expect(document.getElementById("a")!.closest(".it-wrap")!.textContent).toContain("【译】");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("整批失败且一段在途被还原：还原处不出失败占位、不计入失败统计", async () => {
    document.body.innerHTML = `<p id="a">${LONG}</p><p id="b">${LONG2}</p>`;
    const rejecters: Array<(e: unknown) => void> = [];
    sendMessage.mockImplementation((msg: { type: string; texts?: string[] }) => {
      if (msg?.type === "check-cache") return Promise.resolve({ cachedCount: 0 });
      return new Promise((_, reject) => {
        rejecters.push(reject);
      });
    });

    const engine = makeEngine();
    engine.translateElement(document.getElementById("a")!);
    engine.translateElement(document.getElementById("b")!);
    await waitFor(() => rejecters.length > 0); // 在途

    engine.restoreElement(document.getElementById("a")!); // 在途时还原 a
    for (const r of rejecters) r(new Error("network down")); // 整批失败

    await waitFor(() => document.querySelector(".it-error") !== null);
    await flush();

    const a = document.getElementById("a")!;
    expect(a.closest(".it-wrap")).toBeNull(); // 失败路径的撤销守卫：不给已还原段落插错误占位
    expect(document.querySelectorAll(".it-error").length).toBe(1); // 只有 b 计失败
    expect(a.hasAttribute("data-it-processing")).toBe(false);
    const b = document.getElementById("b")!;
    expect(b.closest(".it-wrap")!.querySelector(".it-error")).not.toBeNull();
  });
});

describe("SPA 导航延迟重译 vs 手动还原", () => {
  it("换页后 200ms 窗口内手动还原：兜底重译让路，页面保持原文", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    // 假定时器环境下所有等待都走 advanceTimers：真实 setTimeout 不会被推进，会永久挂起
    const tick = async (ms: number): Promise<void> => {
      await vi.advanceTimersByTimeAsync(ms);
    };

    const settings = makeSettings();
    const renderer = new Renderer(settings.translate.displayMode);
    const engine = makeEngine(settings);
    const observer = new PageObserver(engine);
    setupSpaNavigation({
      engine,
      renderer,
      observer,
      autoTranslate: true,
      isSensitive: () => false,
      isPageDisabled: () => false,
      ensureToolbar: () => {},
    });

    document.body.innerHTML = `<p id="a">${LONG}</p>`;
    // 首页翻译完成（假时钟下请求 mock 纯微任务，推进 1ms 让异步链落定）
    void engine.translateAll();
    await tick(10);
    expect(engine.state).not.toBe("off");

    // 换页（pushState + body 替换）→ resetForNavigation + 200ms 后兜底重译
    history.pushState({}, "", "https://github.com/settings/admin");
    const newBody = document.createElement("body");
    newBody.innerHTML = `<p id="b">${LONG2}</p>`;
    document.body.replaceWith(newBody);
    await tick(10); // observer 上报 body 替换 + resetForNavigation；重译定时器尚未到期

    // 200ms 窗口内用户点「还原」
    engine.restore();
    expect(engine.restoredByUser).toBe(true);

    // 兜底重译定时器到期：必须让路，页面保持原文
    await tick(400);
    expect(engine.state).toBe("off");
    expect(engine.hasTranslated()).toBe(false);
    expect(document.querySelectorAll(".it-translated").length).toBe(0);

    observer.disconnect();
  });
});
