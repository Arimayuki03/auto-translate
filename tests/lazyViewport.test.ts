// @vitest-environment jsdom
/**
 * 视口懒翻译门控回归：IntersectionObserver 首次回调会把【所有被观察目标】都派发为
 * entries（含未进视口的，isIntersecting=false）。必须只处理 isIntersecting=true 的，
 * 否则屏幕外几百个单元会被一次性全量翻译 → 大页面卡死（本 bug 的真实来源）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      viewportLazy: true, // 开启懒翻译
      terminology: [],
    },
    sites: { whitelist: [], blacklist: [] },
    tts: { enabled: true, voice: "", rate: 0 },
    security: { encryptApiKey: false, sensitivePages: false },
    cache: { enabled: true, maxEntries: 500 },
  };
}

let sendMessage: ReturnType<typeof vi.fn>;
let ioCallback: ((entries: Partial<IntersectionObserverEntry>[], observer: unknown) => void) | null;
let observedElements: Set<Element>;
const OriginalIO = globalThis.IntersectionObserver;

/** 受控 IntersectionObserver：捕获回调与被观察元素，测试里手动派发 entries */
class MockIntersectionObserver {
  constructor(cb: (entries: Partial<IntersectionObserverEntry>[], observer: unknown) => void) {
    ioCallback = cb;
    this.targets = new Set();
  }
  targets: Set<Element>;
  observe(el: Element): void {
    this.targets.add(el);
    observedElements.add(el);
  }
  unobserve(el: Element): void {
    this.targets.delete(el);
  }
  disconnect(): void {
    this.targets.clear();
  }
}

function mockChrome(): void {
  sendMessage = vi.fn(async (msg: { type: string; texts?: string[]; id?: string }) => {
    if (msg?.type === "translate") {
      return { id: msg.id, ok: true, results: (msg.texts ?? []).map((t) => `【译】${t}`) };
    }
    if (msg?.type === "check-cache") return { cachedCount: 0 };
    return undefined;
  });
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { sendMessage },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
  } as unknown as typeof chrome;
}

beforeEach(() => {
  ioCallback = null;
  observedElements = new Set();
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    MockIntersectionObserver;
  document.body.innerHTML = `
    <p>First paragraph text here.</p>
    <p>Second paragraph text here.</p>
    <p>Third paragraph text here.</p>
  `;
  mockChrome();
});

afterEach(() => {
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = OriginalIO;
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
}

/** flushLazy 的防抖是 60ms，等它触发并完成翻译 */
async function waitLazyFlush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 120));
  await flush();
}

function translatedTexts(): string[] {
  return sendMessage.mock.calls
    .map((c) => c[0])
    .filter((m) => m?.type === "translate")
    .flatMap((m) => m.texts ?? []);
}

describe("视口懒翻译 isIntersecting 门控", () => {
  it("初始不翻译视口外单元，只把它们交给 IntersectionObserver 观察", async () => {
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    await engine.translateAll();
    await flush();

    // jsdom 中 getBoundingClientRect 全为 0 → inViewport 恒 false → 单元全进懒观察
    expect(observedElements.size).toBeGreaterThan(0);
    // 初始尚未有任何单元进视口 → 不应发起任何翻译请求
    expect(translatedTexts()).toHaveLength(0);
  });

  it("只有 isIntersecting=true 的单元被翻译；false 的保持等待", async () => {
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    await engine.translateAll();
    await flush();
    expect(ioCallback).not.toBeNull();

    const paragraphs = Array.from(document.querySelectorAll("p"));
    // 模拟 IO 回调：第一个进入视口(true)，第二个未进(false)
    ioCallback!(
      [
        { target: paragraphs[0], isIntersecting: true },
        { target: paragraphs[1], isIntersecting: false },
      ],
      {}
    );
    await waitLazyFlush();

    const texts = translatedTexts();
    expect(texts).toContain("First paragraph text here.");
    // 未进视口的不能被翻译（回归点：旧 bug 会把它也一起翻译）
    expect(texts).not.toContain("Second paragraph text here.");
  });

  it("后续滚动进视口的单元会被补译", async () => {
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    await engine.translateAll();
    await flush();

    const paragraphs = Array.from(document.querySelectorAll("p"));
    // 第一次：只有第一个进视口
    ioCallback!([{ target: paragraphs[0], isIntersecting: true }], {});
    await waitLazyFlush();
    expect(translatedTexts()).toContain("First paragraph text here.");

    // 第二次：第二个滚动进视口
    ioCallback!([{ target: paragraphs[1], isIntersecting: true }], {});
    await waitLazyFlush();
    expect(translatedTexts()).toContain("Second paragraph text here.");
  });
});
