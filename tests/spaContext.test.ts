// @vitest-environment jsdom
/**
 * SPA 换页上下文清理回归：换页（resetForNavigation）后，旧页的标题/正文摘要
 * 不能再作为语境注入新页翻译。若观察器先于 translateAll 触发翻译，
 * 请求不应携带旧上下文（下次 translateAll 会按新页重新计算）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageEngine } from "../src/content/engine";
import { Renderer } from "../src/content/renderer";
import { extractUnits } from "../src/content/extractor";
import type { TranslationContext } from "../src/shared/messages";
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
      viewportLazy: false,
      terminology: [],
      contextEnabled: true,
      contextMaxChars: 3000,
    },
    sites: { whitelist: [], blacklist: [] },
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
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { sendMessage },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
  } as unknown as typeof chrome;
}

/** 收集所有 translate 请求携带的 context */
function sentContexts(): (TranslationContext | undefined)[] {
  return sendMessage.mock.calls
    .map((c) => c[0] as { type?: string; context?: TranslationContext })
    .filter((m) => m?.type === "translate")
    .map((m) => m.context);
}

beforeEach(() => {
  mockChrome();
});

afterEach(() => vi.restoreAllMocks());

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
}

describe("SPA 换页清理旧上下文", () => {
  it("整页翻译携带旧页上下文", async () => {
    document.title = "旧页面标题";
    document.body.innerHTML = `<p>Old page paragraph text.</p>`;
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    await engine.translateAll();
    await flush();

    const contexts = sentContexts();
    expect(contexts.length).toBeGreaterThan(0);
    // 上下文注入了旧页标题
    expect(contexts[0]?.title).toBe("旧页面标题");
  });

  it("resetForNavigation 后：观察器先触发的翻译不复用旧页上下文", async () => {
    document.title = "旧页面标题";
    document.body.innerHTML = `<p>Old page paragraph text.</p>`;
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    await engine.translateAll();
    await flush();
    expect(sentContexts()[0]?.title).toBe("旧页面标题");

    // SPA 换页：重置引擎状态并清理旧上下文
    engine.resetForNavigation();

    // 换新页内容，模拟观察器在 translateAll 之前直接调度新单元
    document.title = "新页面标题";
    document.body.innerHTML = `<p>New page paragraph text.</p>`;
    const units = extractUnits(document.body, engine.extractOptions);
    await engine.translateUnits(units);
    await flush();

    // 最后一次 translate 请求不应携带旧页上下文（上下文已作废，待 translateAll 重算）
    const contexts = sentContexts();
    expect(contexts[contexts.length - 1]).toBeUndefined();
    // 新内容正常翻译
    expect(document.body.textContent).toContain("【译】New page paragraph text.");
  });

  it("换页后 translateAll 会按新页重新计算上下文", async () => {
    document.title = "旧页面标题";
    document.body.innerHTML = `<p>Old page paragraph text.</p>`;
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    await engine.translateAll();
    await flush();

    engine.resetForNavigation();
    document.title = "新页面标题";
    document.body.innerHTML = `<p>New page paragraph text.</p>`;
    await engine.translateAll();
    await flush();

    const contexts = sentContexts();
    expect(contexts[contexts.length - 1]?.title).toBe("新页面标题");
  });
});
