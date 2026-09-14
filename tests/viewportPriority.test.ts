// @vitest-environment jsdom
/**
 * 视口优先调度回归：
 * - 整页直译时批次按「距视口距离」出队：当前屏幕的段落最先请求/渲染；
 * - 出队前按当前视口重选：滚动后未发出的批次跟随用户位置（滚动跟读首屏更快）；
 * - 距离并列（jsdom rect 恒 0）时退化为 DOM 顺序，不改变既有行为。
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
      viewportLazy: false, // 整页直译路径：全部单元一次进 translateUnits
      terminology: [],
    },
    sites: { whitelist: [], blacklist: [], rules: [], disabledRuleIds: [] },
    security: { encryptApiKey: false, sensitivePages: false },
    cache: { enabled: true, maxEntries: 500 },
  };
}

type Deferred = { resolve: (v: unknown) => void; texts: string[] };

let sendMessage: ReturnType<typeof vi.fn>;
let requests: string[][];
let deferreds: Deferred[];

/** 可控 sendMessage：translate 请求挂起不回复，测试里按需放行 */
function mockDeferredChrome(): void {
  requests = [];
  deferreds = [];
  sendMessage = vi.fn(async (msg: { type: string; texts?: string[]; id?: string }) => {
    if (msg?.type === "translate") {
      const texts = msg.texts ?? [];
      requests.push(texts);
      return new Promise((resolve) => deferreds.push({ resolve, texts }));
    }
    if (msg?.type === "check-cache") return { cachedCount: 0 };
    return undefined;
  });
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { sendMessage },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
  } as unknown as typeof chrome;
}

function stubRect(el: HTMLElement, top: number): void {
  el.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + 20,
      left: 0,
      right: 100,
      width: 100,
      height: 20,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function paragraphText(i: number): string {
  return `Sample paragraph number ${i} for testing.`;
}

function buildParagraphs(count: number, nearCount: number): HTMLElement[] {
  document.body.innerHTML = "";
  const els: HTMLElement[] = [];
  for (let i = 0; i < count; i++) {
    const p = document.createElement("p");
    p.textContent = paragraphText(i);
    document.body.appendChild(p);
    stubRect(p, i < nearCount ? 10 + i : 10000 + i * 10);
    els.push(p);
  }
  return els;
}

/** 轮询等待条件成立：引擎提取/调度是多层异步链，固定轮数的 flush 在高负载下会提前返回 */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
    await Promise.resolve();
  }
}

async function flushAll(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
  }
}

beforeEach(mockDeferredChrome);
afterEach(() => vi.restoreAllMocks());

describe("视口优先调度", () => {
  it("整页直译：距视口最近的段落出现在首个请求的最前面", async () => {
    // p0..p9 可见（top 10..19），p10..p39 远（top 10000+）
    buildParagraphs(40, 10);
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    await engine.translateAll();
    await flushAll();

    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]![0]).toBe(paragraphText(0));
    // 可见的 10 段全部排在远端段落之前
    const first = requests[0]!;
    expect(first.indexOf(paragraphText(9))!).toBeLessThan(first.indexOf(paragraphText(10))!);

    // 放行全部挂起请求，整页仍会全部译完
    for (const d of deferreds.splice(0)) {
      d.resolve({ id: "x", ok: true, results: d.texts.map((t) => `【译】${t}`) });
    }
    await flushAll();
    await flushAll();
    const all = requests.flat();
    expect(all).toContain(paragraphText(39));
  });

  it("出队前按当前视口重选：滚动后未发出的批次跟随用户位置", async () => {
    // 180 段 → 6 批（30 单元/批）：B0=p0..29 … B5=p150..179
    // FETCH_WINDOW=4 → B0..B3 先发出，B4/B5 待发
    buildParagraphs(180, 10);
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    await engine.translateAll();
    await waitFor(() => requests.length === 4); // B0..B3 在途

    // 模拟用户滚到 p150 附近：B5 锚点变成距视口最近
    stubRect(document.querySelectorAll("p")[150] as HTMLElement, 50);

    // 放行 B0：主循环补发一个新批 → 应选 B5（p150）而不是按 DOM 顺序的 B4（p120）
    deferreds[0]!.resolve({
      id: "x",
      ok: true,
      results: deferreds[0]!.texts.map((t) => `【译】${t}`),
    });
    await waitFor(() => requests.length === 5);
    expect(requests[4]![0]).toBe(paragraphText(150));

    // 收尾：放行剩余请求让引擎走完状态机
    for (const d of deferreds.splice(0)) {
      d.resolve({ id: "x", ok: true, results: d.texts.map((t) => `【译】${t}`) });
    }
    await flushAll();
  });

  it("距离并列（rect 全 0）时保持 DOM 顺序，不破坏既有行为", async () => {
    document.body.innerHTML = "<p>Alpha paragraph here.</p><p>Beta paragraph here.</p>";
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    await engine.translateAll();
    await waitFor(() => requests.length === 1);

    expect(requests[0]).toEqual(["Alpha paragraph here.", "Beta paragraph here."]);

    for (const d of deferreds.splice(0)) {
      d.resolve({ id: "x", ok: true, results: d.texts.map((t) => `【译】${t}`) });
    }
    await flushAll();
  });
});
