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
import { installChromeMock, uninstallChromeMock } from "./helpers/chromeMock";
import { PageEngine } from "../src/content/engine";
import { Renderer } from "../src/content/renderer";
import type { Settings } from "../src/shared/types";

const TRANS = "你好世界";

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

beforeEach(() => {
  sendMessage = vi.fn(async (msg: { type: string; texts?: string[]; id?: string }) => {
    if (msg?.type === "translate") {
      return { id: msg.id, ok: true, results: (msg.texts ?? []).map(() => TRANS) };
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

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 等翻译渲染落地（成功 it-done / 失败 it-error）：translateAll 对调度链不 await，
 *  固定一轮 flush 在多 worker 高负载下会提前返回，造成偶发失败 */
function waitForRendered(): Promise<void> {
  return waitFor(() => document.querySelectorAll(".it-done, .it-error").length > 0);
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
    await waitForRendered();

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
    await waitForRendered();

    engine.renderer.setMode("translated");
    const li = document.querySelector("#t")!;
    expect(visibleText(li)).toBe(TRANS);
    expect(document.querySelector("#t b")!.textContent).toBe(""); // 嵌套原文已清空

    engine.renderer.setMode("bilingual");
    expect(document.querySelector("#t b")!.textContent).toBe("bold"); // 还原
    expect(visibleText(li)).toContain("Hello");
    expect(visibleText(li)).toContain("end");
  });

  it("行内链接：链接文字独立成单元，仅译文下也被原位替换（回归：句子夹英文「漏翻译」）", async () => {
    document.body.innerHTML = `<ul><li id="t">See <a href="#doc">docs page</a> for details</li></ul>`;
    const engine = makeEngine();
    await engine.translateAll();
    await waitForRendered();

    engine.renderer.setMode("translated");
    const a = document.querySelector<HTMLAnchorElement>("#t a")!;
    expect(a.getAttribute("href")).toBe("#doc"); // 结构与 href 不动：依然可点击
    expect(visibleText(a)).toBe(TRANS); // 链接文字被译文原位替换
    const shown = visibleText(document.querySelector("#t")!);
    expect(shown).not.toContain("See"); // 非链接原文被替换
    expect(shown).not.toContain("docs page"); // 不再残留英文片段
    expect(shown).toContain(TRANS);

    engine.renderer.setMode("bilingual");
    const restored = visibleText(document.querySelector("#t")!);
    expect(restored).toContain("See");
    expect(restored).toContain("docs page");
    expect(restored).toContain("for details");
  });
});

describe("仅译文模式：包裹路径与失败占位", () => {
  it("包裹容器（.it-wrap）原文隐藏、只见一份译文", async () => {
    document.body.innerHTML = `<p id="t"><span>Plain text here</span></p>`;
    const engine = makeEngine();
    await engine.translateAll();
    await waitForRendered();

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
    await waitForRendered();
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
    await waitForRendered();

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

describe("仅译文模式：链接可点击（回归：包裹路径 CSS 藏原文连链接一起藏）", () => {
  it("长独立链接：译文原位替换链接文字，href 不变，链接一律行内不套块级包裹", async () => {
    document.body.innerHTML = `<div><a id="t" href="/post/123">A fairly long standalone link text that definitely exceeds forty characters limit</a></div>`;
    const engine = makeEngine();
    await engine.translateAll();
    await waitForRendered();

    engine.renderer.setMode("translated");
    const a = document.querySelector<HTMLAnchorElement>("#t")!;
    expect(a.isConnected).toBe(true);
    expect(a.getAttribute("href")).toBe("/post/123");
    expect(visibleText(a)).toBe(TRANS); // 译文替换进链接内：可见的译文就是链接本身
    expect(document.querySelector("[data-it-orig-hidden]")).toBeNull(); // 原文块未被 CSS 藏掉
    expect(a.closest(".it-wrap")).toBeNull(); // 行内链接绝不套块级 .it-wrap（会在父块里裂出行）
    const transEl = a.querySelector(":scope > .it-translated")!;
    expect(transEl).toBeTruthy(); // 双语形态：译文内嵌在链接内
    expect(transEl.classList.contains("it-translated-hidden")).toBe(true); // 仅译文下隐藏，避免重复

    // 切回双语：链接原文还原、译文元素重新可见
    engine.renderer.setMode("bilingual");
    expect(a.textContent).toContain("A fairly long standalone");
    expect(transEl.classList.contains("it-translated-hidden")).toBe(false);
  });

  it("标题链接（<h2><a>）：仅译文下链接保持可点击且文字被译文替换", async () => {
    document.body.innerHTML = `<div><h2><a id="t" href="/x">Headline text long enough to exceed the forty character compact threshold for sure</a></h2></div>`;
    const engine = makeEngine();
    await engine.translateAll();
    await waitForRendered();

    engine.renderer.setMode("translated");
    const a = document.querySelector<HTMLAnchorElement>("#t")!;
    expect(a.getAttribute("href")).toBe("/x");
    expect(visibleText(a)).toBe(TRANS);
    expect(document.querySelector("[data-it-orig-hidden]")).toBeNull();

    engine.renderer.setMode("bilingual");
    expect(a.textContent).toContain("Headline text");
  });

  it("段落内嵌链接：链接文字也被原位替换（译文完整），元素与 href 不动仍可点击", async () => {
    document.body.innerHTML = `<div id="t">Read the docs <a href="/d">here</a> for more info</div>`;
    const engine = makeEngine();
    await engine.translateAll();
    await waitForRendered();

    engine.renderer.setMode("translated");
    const a = document.querySelector<HTMLAnchorElement>("#t a")!;
    expect(a.getAttribute("href")).toBe("/d");
    expect(visibleText(a)).toBe(TRANS); // 链接文字被译文替换——不再在译文句子里夹英文残渣
    const div = document.querySelector("#t")!;
    const shown = visibleText(div);
    expect(shown).toContain(TRANS); // 周围文字被替换为译文
    expect(shown).not.toContain("Read the docs");
    expect(shown).not.toContain("here");

    engine.renderer.setMode("bilingual");
    const restored = visibleText(div);
    expect(restored).toContain("Read the docs");
    expect(restored).toContain("here");
    expect(restored).toContain("for more info");
  });

  it("<li><a> 单链接容器：切回双语后链接原文恢复（回归：标记打在链接上漏还原）", async () => {
    document.body.innerHTML = `<ul><li id="t"><a href="/m">Menu entry</a></li></ul>`;
    const engine = makeEngine();
    await engine.translateAll();
    await waitForRendered();

    engine.renderer.setMode("translated");
    const a = document.querySelector<HTMLAnchorElement>("#t a")!;
    expect(visibleText(a)).toBe(TRANS); // 链接文字被替换（保持可点击）

    engine.renderer.setMode("bilingual");
    expect(a.textContent).toContain("Menu entry"); // 原文恢复（旧实现漏还原，残留译文）
    const shown = visibleText(document.querySelector("#t")!);
    expect(shown).toContain("Menu entry");
    expect(shown).toContain(TRANS); // 行内译文元素恢复显示
  });

  it("嵌套翻译单元：仅译文替换不越界改写内层单元，切回后内层原文完整", async () => {
    document.body.innerHTML = `<div id="outer">Intro words <p id="inner">Nested paragraph content</p></div>`;
    const engine = makeEngine();
    await engine.translateAll();
    await waitForRendered();

    engine.renderer.setMode("translated");
    expect(visibleText(document.querySelector("#inner")!)).toBe(TRANS); // 内层单元正常替换

    engine.renderer.setMode("bilingual");
    expect(document.querySelector("#inner")!.textContent).toContain("Nested paragraph content");
    expect(visibleText(document.querySelector("#outer")!)).toContain("Intro words");
  });

  it("包裹容器原文全在保护子树里（video 兜底文案）：退回 CSS 切换，译文可见", async () => {
    document.body.innerHTML = `<div id="t"><video>Your browser does not support embedded videos, please upgrade to continue watching.</video></div>`;
    const engine = makeEngine();
    await engine.translateAll();
    await waitForRendered();

    engine.renderer.setMode("translated");
    const div = document.querySelector("#t")!;
    expect(div.getAttribute("data-it-orig-hidden")).toBe(""); // 无可替换文本节点 → 走 CSS 切换路径
    expect(div.querySelector("video")!.textContent).toContain("Your browser"); // 保护子树文字原样保留
    const transEl = div.closest(".it-wrap")!.querySelector(":scope > .it-translated")!;
    expect(transEl.classList.contains("it-translated-hidden")).toBe(false); // 译文顶替显示
    expect(visibleText(document.body)).toBe(TRANS); // 可见的只有译文

    engine.renderer.setMode("bilingual");
    expect(div.hasAttribute("data-it-orig-hidden")).toBe(false); // 原文恢复可见
    expect(visibleText(document.body)).toContain("Your browser");
  });
});

describe("渲染/记账一致性回归（B8/B9）", () => {
  // B8 回归：混合批次里空译文段不得渲染成「空白但成功」——走失败角标路径
  it("混合批次空译文段：失败角标（it-error）而非空白成功块，不计入已译", async () => {
    document.body.innerHTML = `<p id="ok">Good paragraph for translation.</p><p id="bad">Empty result paragraph here.</p>`;
    // 后台对失败段静默返回 ""（A2 修复后的常态）：bad 段空、ok 段正常——同一批混合
    sendMessage.mockImplementation(async (msg: { type: string; texts?: string[]; id?: string }) => {
      if (msg?.type === "translate") {
        return {
          id: msg.id,
          ok: true,
          results: (msg.texts ?? []).map((t) => (t === "Empty result paragraph here." ? "" : TRANS)),
        };
      }
      if (msg?.type === "check-cache") return { cachedCount: 0 };
      return undefined;
    });

    const engine = makeEngine();
    const lastStats: { done: number; error: number } = { done: 0, error: 0 };
    engine.onStateChange = (_state, stats) => {
      lastStats.done = stats.done;
      lastStats.error = stats.error;
    };
    await engine.translateAll();
    await waitForRendered();

    // 空译文段：失败角标，无空白 it-done 占位
    const bad = document.getElementById("bad")!;
    const badWrap = bad.closest(".it-wrap");
    expect(badWrap).not.toBeNull();
    expect(badWrap!.querySelector(".it-translated.it-error")).not.toBeNull();
    expect(badWrap!.querySelector(".it-translated.it-done")).toBeNull();

    // 同批正常段照常成功
    const ok = document.getElementById("ok")!;
    expect(ok.closest(".it-wrap")!.querySelector(".it-translated.it-done")).not.toBeNull();

    // 记账：空段不算成功、不进 doneTexts（重试/再扫描不被去重口径压住）
    expect(lastStats.error).toBe(1);
    expect(lastStats.done).toBe(1);
    expect(engine.isSkipped("Empty result paragraph here.")).toBe(false);
    expect(engine.isSkipped("Good paragraph for translation.")).toBe(true);
  });

  // B9 回归：译文等于完整原文时不得清空其余文本节点（免译哨兵回显的段落截断）
  it("多文本节点元素 + 译文等于原文：渲染与还原后各节点文本与原快照一致（不被清空）", async () => {
    // 多文本节点结构：div 内 3 个文本节点（Alpha part / span 内 mid part / tail part）
    document.body.innerHTML = `<div id="t">Alpha part <span>mid part</span> tail part</div>`;
    const div = document.querySelector<HTMLElement>("#t")!;
    const before = {
      head: div.firstChild?.textContent ?? "",
      mid: div.querySelector("span")!.firstChild?.textContent ?? "",
      tail: div.lastChild?.textContent ?? "",
    };
    const original = "Alpha part mid part tail part";
    expect(`${before.head}${before.mid}${before.tail}`).toBe(original);

    // 译文=完整原文（免译哨兵回显：mapNoTranslationNeeded 返回原文）
    sendMessage.mockImplementation(async (msg: { type: string; texts?: string[]; id?: string }) => {
      if (msg?.type === "translate") {
        return { id: msg.id, ok: true, results: (msg.texts ?? []).map(() => original) };
      }
      if (msg?.type === "check-cache") return { cachedCount: 0 };
      return undefined;
    });

    const engine = makeEngine();
    await engine.translateAll();
    await waitForRendered();

    engine.renderer.setMode("translated");
    // 各文本节点原样保留：宿主节点没换字，其余节点也不被清空（旧实现 tail 被清空 → 段落截断）
    expect(div.firstChild?.textContent).toBe(before.head);
    expect(div.querySelector("span")!.firstChild?.textContent).toBe(before.mid);
    expect(div.lastChild?.textContent).toBe(before.tail);
    expect(div.textContent).toBe(original);

    // 还原路径同样一致（快照未被错误改写）
    engine.restore();
    expect(div.firstChild?.textContent).toBe(before.head);
    expect(div.querySelector("span")!.firstChild?.textContent).toBe(before.mid);
    expect(div.lastChild?.textContent).toBe(before.tail);
    expect(div.textContent).toBe(original);
  });
});
