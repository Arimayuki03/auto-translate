// @vitest-environment jsdom
/**
 * 显示模式渲染回归测试（重点：仅译文模式显示异常）：
 * 1. 嵌套元素（<span>/<b>）内的原文必须被替换，不能出现「译文 + 原文」同屏混杂
 *    （li 等内部插入容器走文本原位替换路径，是本次修复的核心路径）；
 * 2. 保护元素（链接）文字保留、href 不变，不被替换逻辑破坏；
 * 3. 切回双语模式后原文完整还原；
 * 4. 翻译失败的占位块在仅译文模式必须隐藏（不能被 .it-wrap 显示规则顶出来）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageEngine } from "../src/content/engine";
import { Renderer } from "../src/content/renderer";
import type { Settings } from "../src/shared/types";

const TRANS = "你好世界";

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
    },
    sites: { whitelist: [], blacklist: [] },
    security: { encryptApiKey: false, sensitivePages: false },
    cache: { enabled: true, maxEntries: 500 },
  };
}

let sendMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sendMessage = vi.fn(async (msg: { type: string; texts?: string[]; id?: string }) => {
    if (msg?.type === "translate") {
      return { id: msg.id, ok: true, results: (msg.texts ?? []).map(() => TRANS) };
    }
    if (msg?.type === "check-cache") return { cachedCount: 0 };
    return undefined;
  });
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { sendMessage },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
  } as unknown as typeof chrome;
});

afterEach(() => vi.restoreAllMocks());

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
}

function makeEngine() {
  const renderer = new Renderer("bilingual");
  return new PageEngine(renderer, makeSettings());
}

/** 模拟用户所见文字：jsdom 不计算 CSS，按隐藏标记类/属性排除不可见节点 */
function visibleText(root: Element): string {
  const hiddenSel = ".it-translated-hidden, .it-pending, [data-it-orig-hidden]";
  const marked: Element[] = [];
  root.querySelectorAll(hiddenSel).forEach((el) => {
    el.setAttribute("data-it-test-hidden", "");
    marked.push(el);
  });
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (let p = node.parentElement; p; p = p.parentElement) {
        if (p.hasAttribute("data-it-test-hidden")) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode())) text += n.textContent ?? "";
  marked.forEach((el) => el.removeAttribute("data-it-test-hidden"));
  return text.replace(/\s+/g, " ").trim();
}

describe("仅译文模式：嵌套元素原文替换（回归：译文与原文同屏混杂）", () => {
  it("嵌套 <span> 内的原文被替换，页面只见译文", async () => {
    document.body.innerHTML = `<ul><li id="t"><span>Hello</span> <span>world</span></li></ul>`;
    const engine = makeEngine();
    await engine.translateAll();
    await flush();

    engine.renderer.setMode("translated");
    const li = document.querySelector("#t")!;
    expect(visibleText(li)).toBe(TRANS); // 原文不残留
    expect(li.textContent).not.toContain("Hello"); // 嵌套 span 里的原文已被清空替换

    // 切回双语：原文完整还原
    engine.renderer.setMode("bilingual");
    const shown = visibleText(li);
    expect(shown).toContain("Hello");
    expect(shown).toContain("world");
    expect(shown).toContain(TRANS); // 双语对照仍有译文
  });

  it("混合结构（直接文本 + 嵌套 <b>）原文全部被替换并可还原", async () => {
    document.body.innerHTML = `<ul><li id="t">Hello <b>bold</b> end</li></ul>`;
    const engine = makeEngine();
    await engine.translateAll();
    await flush();

    engine.renderer.setMode("translated");
    const li = document.querySelector("#t")!;
    expect(visibleText(li)).toBe(TRANS);
    expect(document.querySelector("#t b")!.textContent).toBe(""); // 嵌套原文已清空

    engine.renderer.setMode("bilingual");
    expect(document.querySelector("#t b")!.textContent).toBe("bold"); // 还原
    expect(visibleText(li)).toContain("Hello");
    expect(visibleText(li)).toContain("end");
  });

  it("保护元素：<a> 链接文字保留且 href 不变（可点击）", async () => {
    document.body.innerHTML = `<ul><li id="t">See <a href="#doc">docs page</a> for details</li></ul>`;
    const engine = makeEngine();
    await engine.translateAll();
    await flush();

    engine.renderer.setMode("translated");
    const a = document.querySelector<HTMLAnchorElement>("#t a")!;
    expect(a.textContent).toBe("docs page"); // 链接文字不动
    expect(a.getAttribute("href")).toBe("#doc");
    const shown = visibleText(document.querySelector("#t")!);
    expect(shown).not.toContain("See"); // 非链接原文被替换
    expect(shown).toContain(TRANS);
    expect(shown).toContain("docs page");

    engine.renderer.setMode("bilingual");
    const restored = visibleText(document.querySelector("#t")!);
    expect(restored).toContain("See");
    expect(restored).toContain("for details");
  });
});

describe("仅译文模式：包裹路径与失败占位", () => {
  it("包裹容器（.it-wrap）原文隐藏、只见一份译文", async () => {
    document.body.innerHTML = `<p id="t"><span>Plain text here</span></p>`;
    const engine = makeEngine();
    await engine.translateAll();
    await flush();

    engine.renderer.setMode("translated");
    const shown = visibleText(document.body);
    expect(shown.split(TRANS).length - 1).toBe(1); // 译文只出现一次
    expect(shown).not.toContain("Plain text"); // 原文被隐藏
  });

  it("双语下翻译失败后切仅译文，错误块被隐藏且原文保持可见", async () => {
    document.body.innerHTML = `<p>Need translation here.</p>`;
    sendMessage.mockImplementation(async (msg: { type: string; id?: string }) => {
      if (msg?.type === "translate") return { id: msg.id, ok: false, error: "boom" };
      if (msg?.type === "check-cache") return { cachedCount: 0 };
      return undefined;
    });

    const engine = makeEngine();
    await engine.translateAll();
    await flush();
    expect(document.querySelectorAll(".it-translated.it-error").length).toBeGreaterThan(0);

    engine.renderer.setMode("translated");
    // 所有失败占位都带隐藏类（CSS 高特异性规则保证不被 wrap 显示规则覆盖）
    for (const el of Array.from(document.querySelectorAll(".it-translated.it-error"))) {
      expect(el.classList.contains("it-translated-hidden")).toBe(true);
    }
    // 原文保持可见（失败不应覆盖原文），错误文字不可见
    const shown = visibleText(document.body);
    expect(shown).toContain("Need translation here.");
    expect(shown).not.toContain("翻译失败");

    // 切回双语：错误块恢复显示（用户可点重试）
    engine.renderer.setMode("bilingual");
    for (const el of Array.from(document.querySelectorAll(".it-translated.it-error"))) {
      expect(el.classList.contains("it-translated-hidden")).toBe(false);
    }
  });
});

describe("布局保真：译文不新增布局项、不挤走原有组件", () => {
  it("导航链接译文插在链接内部：nav 直接子元素数量不变", async () => {
    document.body.innerHTML = `<nav><a href="/a">Home page</a><a href="/b">Settings</a></nav>`;
    const engine = makeEngine();
    await engine.translateAll();
    await flush();

    const nav = document.querySelector("nav")!;
    expect(nav.children.length).toBe(2); // 不新增兄弟元素（flex 导航里兄弟即布局项）
    const a = nav.querySelector<HTMLAnchorElement>("a")!;
    expect(a.querySelector(".it-translated")).not.toBeNull(); // 译文在链接内部
    expect(a.getAttribute("href")).toBe("/a"); // 链接可点击性不变

    // 仅译文模式：链接文字被替换、仍只有一个可见文本
    engine.renderer.setMode("translated");
    expect(visibleText(a)).toBe(TRANS);
    expect(a.getAttribute("href")).toBe("/a");
  });
});
