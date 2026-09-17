// @vitest-environment jsdom
/**
 * 站点规则库接入提取管线回归：
 * - excludeSelectors：排除区子树（正文与属性翻译）不再提取；
 * - excludeTags：指定标签内的文本一律跳过；
 * - forceBlockTags：自定义元素强制按块级容器处理（不再与兄弟合并成一个单元）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageEngine } from "../src/content/engine";
import { Renderer } from "../src/content/renderer";
import { extractUnits } from "../src/content/extractor";
import { resolveSiteRules } from "../src/shared/siteRules";
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
      autoTranslate: false,
      autoDetectSource: true,
      minTextLength: 2,
      blockMaxChars: 1200,
      translateOnSelect: true,
      translateInput: true,
      viewportLazy: false,
      terminology: [],
    },
    sites: { whitelist: [], blacklist: [], rules: [], disabledRuleIds: [] },
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
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { sendMessage },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
  } as unknown as typeof chrome;
}

/** 构造命中 localhost 的规则解析结果（jsdom 默认 URL 是 https://github.com，这里显式传 href） */
function resolvedFor(href: string, userRules: Parameters<typeof resolveSiteRules>[1] = []) {
  return resolveSiteRules(href, userRules, []);
}

beforeEach(() => mockChrome());
afterEach(() => vi.restoreAllMocks());

describe("站点规则 × 文本提取", () => {
  it("excludeSelectors：排除区子树不提取，区外正常提取", () => {
    document.body.innerHTML = `
      <div class="content">Main content paragraph here.</div>
      <aside class="no-translate">Sidebar junk text should be ignored.</aside>
    `;
    const opts = {
      minTextLength: 2,
      blockMaxChars: 1200,
      targetLang: "zh-CN",
      ...resolvedFor("https://localhost/", [
        { matches: ["localhost"], excludeSelectors: [".no-translate"] },
      ]),
    };
    const units = extractUnits(document.body, opts);
    const texts = units.map((u) => u.text);
    expect(texts).toContain("Main content paragraph here.");
    expect(texts.some((t) => t.includes("Sidebar junk"))).toBe(false);
  });

  it("excludeTags：指定标签内的文本一律跳过（含嵌套）", () => {
    document.body.innerHTML = `
      <p>Readable paragraph text.</p>
      <p>Before <custom-icon>ICONDATA</custom-icon> after words.</p>
    `;
    const opts = {
      minTextLength: 2,
      blockMaxChars: 1200,
      targetLang: "zh-CN",
      ...resolvedFor("https://localhost/", [
        { matches: ["localhost"], excludeTags: ["custom-icon"] },
      ]),
    };
    const units = extractUnits(document.body, opts);
    const texts = units.map((u) => u.text).join("\n");
    expect(texts).toContain("Readable paragraph text.");
    expect(texts).toContain("Before after words."); // 排除标签外的同段文本保留
    expect(texts).not.toContain("ICONDATA");
  });

  it("forceBlockTags：自定义元素每个自成翻译单元，不与兄弟合并", () => {
    document.body.innerHTML = `
      <div><my-block>First block sentence.</my-block><my-block>Second block sentence.</my-block></div>
    `;
    const base = { minTextLength: 2, blockMaxChars: 1200, targetLang: "zh-CN" };
    const without = extractUnits(document.body, base);
    // 未配置规则：两个 my-block 的文本合并进同一个 div 单元
    expect(without).toHaveLength(1);
    expect(without[0].text).toContain("First block sentence.");

    const withRule = extractUnits(document.body, {
      ...base,
      ...resolvedFor("https://localhost/", [
        { matches: ["localhost"], forceBlockTags: ["my-block"] },
      ]),
    });
    expect(withRule).toHaveLength(2);
    expect(withRule.map((u) => u.text)).toEqual([
      "First block sentence.",
      "Second block sentence.",
    ]);
  });

  it("站点规则的 excludeSelectors 对 shadow DOM 宿主同样生效", () => {
    const host = document.createElement("div");
    host.className = "widget-zone";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<p>Shadow widget text here.</p>";
    document.body.innerHTML = "<p>Regular page text here.</p>";
    document.body.appendChild(host);

    const opts = {
      minTextLength: 2,
      blockMaxChars: 1200,
      targetLang: "zh-CN",
      ...resolvedFor("https://localhost/", [
        { matches: ["localhost"], excludeSelectors: [".widget-zone"] },
      ]),
    };
    const texts = extractUnits(document.body, opts)
      .map((u) => u.text)
      .join("\n");
    expect(texts).toContain("Regular page text here.");
    expect(texts).not.toContain("Shadow widget text");
  });
});

describe("站点规则 × 属性翻译", () => {
  it("排除区内的 placeholder 不翻译，区外正常翻译", async () => {
    document.body.innerHTML = `
      <input id="in-search" placeholder="Search the site" />
      <aside class="no-translate"><input id="in-junk" placeholder="Junk placeholder value" /></aside>
    `;
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings(), {
      excludeSelector: ".no-translate",
      excludeTags: new Set<string>(),
      forceBlockTags: new Set<string>(),
      matchedRuleIds: [],
    });
    await engine.translateAttributes();
    await new Promise((r) => setTimeout(r, 0));

    expect((document.getElementById("in-search") as HTMLInputElement).placeholder).toBe(
      "【译】Search the site"
    );
    expect((document.getElementById("in-junk") as HTMLInputElement).placeholder).toBe(
      "Junk placeholder value"
    );
  });
});
