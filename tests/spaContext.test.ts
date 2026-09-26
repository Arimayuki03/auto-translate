// @vitest-environment jsdom
/**
 * SPA 换页上下文清理回归：换页（resetForNavigation）后，旧页的标题/正文摘要
 * 不能再作为语境注入新页翻译。若观察器先于 translateAll 触发翻译，
 * 请求不应携带旧上下文（下次 translateAll 会按新页重新计算）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, uninstallChromeMock } from "./helpers/chromeMock";
import { PageEngine } from "../src/content/engine";
import { PageObserver } from "../src/content/observer";
import { Renderer } from "../src/content/renderer";
import { extractUnits } from "../src/content/extractor";
import { setupSpaNavigation } from "../src/content/navigation";
import { resolveSiteRules, EMPTY_SITE_RULE } from "../src/shared/siteRules";
import type { TranslationContext } from "../src/shared/messages";
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
      contextEnabled: true,
      contextMaxChars: 3000,
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

afterEach(() => {
  uninstallChromeMock();
  vi.restoreAllMocks();
});

/** 轮询等待条件成立：提取/调度是多层异步链（chunked 提取按时间片让出），
 *  固定轮数的 flush 在系统高负载下会提前返回，造成偶发失败 */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 等翻译渲染落地：请求发出先于渲染，轮询到 it-done/it-error 即代表该批请求已全部记录 */
function waitForRendered(): Promise<void> {
  return waitFor(
    () => document.querySelectorAll(".it-translated.it-done, .it-translated.it-error").length > 0
  );
}

function translateCallCount(): number {
  return sendMessage.mock.calls.filter((c) => c[0]?.type === "translate").length;
}

describe("SPA 换页清理旧上下文", () => {
  it("整页翻译携带旧页上下文", async () => {
    document.title = "旧页面标题";
    document.body.innerHTML = `<p>Old page paragraph text.</p>`;
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    await engine.translateAll();
    await waitForRendered();

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
    await waitForRendered();
    expect(sentContexts()[0]?.title).toBe("旧页面标题");

    // SPA 换页：重置引擎状态并清理旧上下文
    engine.resetForNavigation();

    // 换新页内容，模拟观察器在 translateAll 之前直接调度新单元
    document.title = "新页面标题";
    document.body.innerHTML = `<p>New page paragraph text.</p>`;
    const units = extractUnits(document.body, engine.extractOptions);
    await engine.translateUnits(units);
    await waitForRendered();

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
    await waitForRendered();

    engine.resetForNavigation();
    document.title = "新页面标题";
    document.body.innerHTML = `<p>New page paragraph text.</p>`;
    await engine.translateAll();
    await waitForRendered();

    const contexts = sentContexts();
    expect(contexts[contexts.length - 1]?.title).toBe("新页面标题");
  });
});

describe("SPA 换页重解析站点规则", () => {
  it("pushState 换页触发 onNavigation 按新 URL 重建规则（仅 hash 变化不触发）", () => {
    // 用户规则只作用于 github.com/settings 路径前缀
    const userRules = [{ matches: ["github.com/settings"], excludeSelectors: [".skip-me"] }];
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    expect(engine.extractOptions.excludeSelector).toBeNull();
    const onNavigation = vi.fn(() =>
      engine.applySiteRule(resolveSiteRules(location.href, userRules, []))
    );
    const observer = new PageObserver(engine);
    setupSpaNavigation({
      engine,
      renderer: new Renderer("bilingual"),
      observer,
      autoTranslate: false,
      isSensitive: () => false,
      isPageDisabled: () => false,
      onNavigation,
      ensureToolbar: vi.fn(),
    });

    history.pushState({}, "", "https://github.com/settings/security");
    expect(onNavigation).toHaveBeenCalledTimes(1);
    // 内置 math-render 规则全站命中，合并串里应包含本路径的用户排除选择器
    expect(engine.extractOptions.excludeSelector).toContain(".skip-me");

    // 仅 hash 变化（锚点跳转）：不算换页，不重解析
    history.pushState({}, "", "https://github.com/settings/security#toc");
    expect(onNavigation).toHaveBeenCalledTimes(1);
    expect(engine.extractOptions.excludeSelector).toContain(".skip-me");
    observer.disconnect(); // 测试结束前断开，避免 MutationObserver 回调串到后续用例
  });

  it("applySiteRule 后提取立即遵守新排除区（换页前的旧规则不再命中）", async () => {
    document.title = "页面标题";
    document.body.innerHTML = `<p>Translate this paragraph.</p><div class="ad-banner">Skipped banner text.</div>`;
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    engine.applySiteRule({ ...EMPTY_SITE_RULE, excludeSelector: ".ad-banner" });

    await engine.translateAll();
    await waitFor(() => translateCallCount() > 0);
    const sent = sendMessage.mock.calls
      .filter((c) => c[0]?.type === "translate")
      .flatMap((c) => (c[0] as { texts?: string[] }).texts ?? []);
    expect(sent).toContain("Translate this paragraph.");
    expect(sent.join("\n")).not.toContain("Skipped banner text.");
  });
});
