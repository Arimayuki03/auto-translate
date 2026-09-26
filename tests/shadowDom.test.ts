// @vitest-environment jsdom
/**
 * Shadow DOM 提取与渲染测试：
 * - extractor 遍历进入 open shadow root（含嵌套），closed shadow 跳过，不重复计数；
 * - shadow 内排除规则（style/aria-hidden）照常生效；
 * - renderer 对 shadow 内单元的占位/填充/样式注入正常工作（jsdom 无 Constructable
 *   Stylesheet，走 <style data-it-ui> 回退分支；adoptedStyleSheets 分支为 Chrome MV3
 *   实机路径，jsdom 无法覆盖）。
 * 已知限制（不在本测试范围）：MutationObserver 不观察 shadow root 内部，动态 shadow
 * 内容由下次全量/点击扫描覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, uninstallChromeMock } from "./helpers/chromeMock";
import { extractUnits } from "../src/content/extractor";
import type { ExtractOptions, TranslationUnit } from "../src/content/extractor";
import { PageEngine } from "../src/content/engine";
import { Renderer } from "../src/content/renderer";
import type { Settings } from "../src/shared/types";

const OPTS: ExtractOptions = {
  minTextLength: 2,
  blockMaxChars: 1200,
  targetLang: "zh-CN",
};

/** 在 body 上挂一个带 open shadow 的宿主，返回 { host, shadowRoot } */
function attachOpenShadow(tag = "my-widget", mode: ShadowRootMode = "open") {
  const host = document.createElement(tag);
  const shadowRoot = host.attachShadow({ mode });
  document.body.appendChild(host);
  return { host, shadowRoot: shadowRoot! };
}

describe("extractor：shadow root 遍历", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("open shadow root 内文本被提取为翻译单元", () => {
    const { shadowRoot } = attachOpenShadow();
    const p = document.createElement("p");
    p.textContent = "Shadow content needs translation.";
    shadowRoot.appendChild(p);

    const units = extractUnits(document.body, OPTS);
    const hit = units.filter((u) => u.text.includes("Shadow content"));
    expect(hit).toHaveLength(1);
    expect(hit[0].container).toBe(p);
  });

  it("closed shadow root 不被遍历", () => {
    const { shadowRoot } = attachOpenShadow("my-widget", "closed");
    const p = document.createElement("p");
    p.textContent = "Closed secret stays untouched.";
    shadowRoot.appendChild(p);

    const units = extractUnits(document.body, OPTS);
    expect(units.some((u) => u.text.includes("Closed secret"))).toBe(false);
  });

  it("light DOM 与 shadow 文本各只提取一次（不重复计数）", () => {
    const p = document.createElement("p");
    p.textContent = "Light side stays here.";
    document.body.appendChild(p);
    const { shadowRoot } = attachOpenShadow();
    const sp = document.createElement("p");
    sp.textContent = "Shadow content needs translation.";
    shadowRoot.appendChild(sp);

    const units = extractUnits(document.body, OPTS);
    const texts = units.map((u) => u.text);
    expect(texts.filter((t) => t.includes("Light side"))).toHaveLength(1);
    expect(texts.filter((t) => t.includes("Shadow content"))).toHaveLength(1);
  });

  it("嵌套 shadow root（shadow 内再挂 shadow）均被提取", () => {
    const { shadowRoot } = attachOpenShadow();
    const outer = document.createElement("p");
    outer.textContent = "Outer shadow text goes here.";
    const innerHost = document.createElement("inner-widget");
    const innerShadow = innerHost.attachShadow({ mode: "open" })!;
    const inner = document.createElement("p");
    inner.textContent = "Inner shadow text goes here.";
    innerShadow.appendChild(inner);
    shadowRoot.append(outer, innerHost);

    const units = extractUnits(document.body, OPTS);
    const texts = units.map((u) => u.text);
    expect(texts.filter((t) => t.includes("Outer shadow"))).toHaveLength(1);
    expect(texts.filter((t) => t.includes("Inner shadow"))).toHaveLength(1);
  });

  it("shadow 内排除规则照常生效（style 内容、aria-hidden 子树）", () => {
    const { shadowRoot } = attachOpenShadow();
    const style = document.createElement("style");
    style.textContent = ".hidden-rule { color: red }";
    const hidden = document.createElement("p");
    hidden.setAttribute("aria-hidden", "true");
    hidden.textContent = "Invisible words inside shadow.";
    const visible = document.createElement("p");
    visible.textContent = "Visible text here.";
    shadowRoot.append(style, hidden, visible);

    const units = extractUnits(document.body, OPTS);
    const texts = units.map((u) => u.text).join("\n");
    expect(texts).toContain("Visible text here.");
    expect(texts).not.toContain("hidden-rule");
    expect(texts).not.toContain("Invisible words");
  });
});

// ===== 渲染集成（renderer 对 shadow 内单元的占位/填充/样式注入） =====

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

/** 取 shadow root 内已注入的译文样式文本（兼容 <style> 回退与 adoptedStyleSheets 两种载体） */
function shadowSheetText(shadowRoot: ShadowRoot): string {
  const style = shadowRoot.querySelector("style[data-it-ui]");
  if (style) return style.textContent ?? "";
  // CSSStyleSheet.cssText 非标准（Chrome 私有），标准口径是逐条 cssRules[].cssText
  const adopted = (shadowRoot as unknown as { adoptedStyleSheets?: readonly CSSStyleSheet[] })
    .adoptedStyleSheets;
  const sheet = adopted?.[0];
  return sheet ? Array.from(sheet.cssRules, (r) => r.cssText).join("\n") : "";
}

function shadowInjectionCount(shadowRoot: ShadowRoot): number {
  const styles = shadowRoot.querySelectorAll("style[data-it-ui]").length;
  const adopted = (shadowRoot as unknown as { adoptedStyleSheets?: readonly CSSStyleSheet[] })
    .adoptedStyleSheets?.length;
  return styles + (adopted ?? 0);
}

function makeShadowUnit(text: string): { shadowRoot: ShadowRoot; unit: TranslationUnit } {
  const { shadowRoot } = attachOpenShadow();
  const p = document.createElement("p");
  p.textContent = text;
  shadowRoot.appendChild(p);
  const units = extractUnits(document.body, OPTS);
  const unit = units.find((u) => u.text === text)!;
  return { shadowRoot, unit };
}

describe("renderer：shadow 内渲染与样式注入", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.body.className = "";
  });

  afterEach(() => vi.restoreAllMocks());

  it("reserve 插入骨架占位、fill 原位填充译文（节点引用跨 shadow 边界有效）", () => {
    const { shadowRoot, unit } = makeShadowUnit("Shadow content needs translation.");
    const renderer = new Renderer("bilingual");

    renderer.reserve(unit);
    const pending = shadowRoot.querySelector(".it-translated.it-pending");
    expect(pending).not.toBeNull();
    expect(unit.container.querySelector(".it-translated")).toBe(pending); // 占位插在容器内部

    renderer.fill(unit, ["影子译文"]);
    const done = shadowRoot.querySelector(".it-translated")!;
    expect(done.classList.contains("it-done")).toBe(true);
    expect(done.textContent).toContain("影子译文");
  });

  it("译文样式子集注入 shadow root，且每个 root 只注入一次", () => {
    const { shadowRoot, unit } = makeShadowUnit("Shadow content needs translation.");
    const renderer = new Renderer("bilingual");

    renderer.reserve(unit);
    const css = shadowSheetText(shadowRoot);
    expect(css).toContain(".it-translated"); // 译文块规则
    expect(css).toContain(".it-pending"); // 骨架屏规则
    expect(css).toContain("it-translated-hidden"); // 隐藏规则

    // 同一 shadow root 内第二个单元：样式不重复注入
    const p2 = document.createElement("p");
    p2.textContent = "Second paragraph for dedupe.";
    shadowRoot.appendChild(p2);
    const unit2 = extractUnits(document.body, OPTS).find(
      (u) => u.text === "Second paragraph for dedupe."
    )!;
    renderer.reserve(unit2);
    expect(shadowInjectionCount(shadowRoot)).toBe(1);

    // light DOM 容器不触发 shadow 注入
    const lightP = document.createElement("p");
    lightP.textContent = "Plain light dom paragraph here.";
    document.body.appendChild(lightP);
    const lightUnit = extractUnits(document.body, OPTS).find(
      (u) => u.text === "Plain light dom paragraph here."
    )!;
    renderer.reserve(lightUnit);
    expect(shadowInjectionCount(shadowRoot)).toBe(1);
  });

  it("模式切换重建 shadow 样式文本（body 模式类不跨 shadow 边界）", () => {
    const { shadowRoot, unit } = makeShadowUnit("Shadow content needs translation.");
    const renderer = new Renderer("bilingual");
    renderer.reserve(unit);

    const before = shadowSheetText(shadowRoot);
    expect(before).toContain("margin-bottom:0"); // 双语：原文去底边距
    expect(before).not.toContain("[data-it-orig-hidden]");

    renderer.setMode("translated");
    const after = shadowSheetText(shadowRoot);
    expect(after).toContain("[data-it-orig-hidden]"); // 仅译文：原文隐藏
    expect(after).not.toContain("margin-bottom:0");

    // 切回双语：原文文字还原、样式文本还原
    renderer.setMode("bilingual");
    expect(unit.container.textContent).toContain("Shadow content needs translation.");
    expect(shadowSheetText(shadowRoot)).toContain("margin-bottom:0");
  });
});

describe("engine：shadow 内单元进入完整翻译管线", () => {
  let sendMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
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
    uninstallChromeMock();
    vi.restoreAllMocks();
  });

  it("translateAll 覆盖 shadow 内容，译文落在 shadow root 内", async () => {
    const { shadowRoot } = attachOpenShadow();
    const p = document.createElement("p");
    p.textContent = "Engine reaches into shadow content.";
    shadowRoot.appendChild(p);

    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    await engine.translateAll();
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();

    const done = shadowRoot.querySelector(".it-translated.it-done");
    expect(done).not.toBeNull();
    expect(done!.textContent).toContain("【译】Engine reaches into shadow content.");
    expect(p.hasAttribute("data-it-processing")).toBe(false);
  });

  // B6 回归：processing 标记清理必须穿 open shadow（querySelectorAll 不跨 shadow 边界）
  it("clearProcessingMarks 清理 shadow 内残留的处理标记（整页还原路径）", async () => {
    const { shadowRoot } = attachOpenShadow();
    const p = document.createElement("p");
    p.textContent = "Marked inside shadow stays clearable.";
    shadowRoot.appendChild(p);

    // 手动模拟在途批次残留的标记（绕过管线直写属性，专测清理遍历）
    p.setAttribute("data-it-processing", "it-batch-999");

    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    engine.restore(); // restore 内部调用 clearProcessingMarks
    expect(p.hasAttribute("data-it-processing")).toBe(false);

    // 全文档口径：light + shadow 均无残留
    expect(document.querySelectorAll("[data-it-processing]").length).toBe(0);
    expect(shadowRoot.querySelectorAll("[data-it-processing]").length).toBe(0);
  });

  it("restoreElement 以该元素为根清理其 open shadow 内的处理标记", async () => {
    const { shadowRoot } = attachOpenShadow();
    // 悬停单元素还原的根宿主（自定义元素可以是提取容器）
    const host = document.querySelector("my-widget")!;
    const innerHost = document.createElement("inner-host");
    innerHost.attachShadow({ mode: "open" });
    const marked = document.createElement("p");
    marked.textContent = "Inner marked paragraph pending render.";
    innerHost.shadowRoot!.appendChild(marked);
    shadowRoot.appendChild(innerHost);
    marked.setAttribute("data-it-processing", "it-batch-7");

    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    engine.restoreElement(host);
    expect(marked.hasAttribute("data-it-processing")).toBe(false);
    expect(document.querySelectorAll("[data-it-processing]").length).toBe(0);
  });
});
