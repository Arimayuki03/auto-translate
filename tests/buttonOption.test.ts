// @vitest-environment jsdom
/**
 * 交互控件翻译策略：
 * - <button> / <option>（下拉选项、点击展开的菜单条目）改走「仅文本原位替换」：
 *   只改文本节点，不插入元素、不改 DOM 结构，点击展开/收起与选中交互不受影响，
 *   图标等子元素原样保留；翻译失败保留原文。
 * - <details>/<summary> 折叠菜单：<summary> 仍翻译，但作为紧凑行内标签渲染（译文跟在后面、
 *   绝不包裹），保住 details>summary 结构，菜单照常可收起。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, uninstallChromeMock } from "./helpers/chromeMock";
import { PageEngine } from "../src/content/engine";
import { Renderer } from "../src/content/renderer";
import { extractUnits } from "../src/content/extractor";
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

beforeEach(() => {
  document.body.innerHTML = `
    <h1>个人资料</h1>
    <p>编辑你的公开资料。</p>
    <button id="toggle">Show more options</button>
    <select id="lang">
      <option>English</option>
      <option>Chinese</option>
    </select>
  `;
  sendMessage = vi.fn(async (msg: { type: string; texts?: string[]; id?: string }) => {
    if (msg?.type === "translate") {
      // 词典分支模拟真实模型「整句译文天然包含其中词组译文」的行为——行内链接
      // 拆段嵌入用例依赖这一点；对整句统一加【译】前缀会让拆段必然失配（走降级）
      const results = (msg.texts ?? []).map((t) => {
        if (t.includes("our support team")) {
          return t
            .replace("Contact", "联系")
            .replace("our support team", "我们的支持团队")
            .replace("anytime", "随时");
        }
        return `【译】${t}`;
      });
      return { id: msg.id, ok: true, results };
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

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
}

function makeEngine(mode: "bilingual" | "translated") {
  const renderer = new Renderer(mode);
  renderer.setMode(mode);
  return new PageEngine(renderer, makeSettings());
}

describe("交互控件翻译策略（仅文本原位替换）", () => {
  it("提取：按钮与下拉选项文字被提取为 textOnly 单元，正文不受影响", () => {
    document.body.innerHTML = `
      <p>Edit your public profile.</p>
      <button id="toggle">Show more options</button>
      <select id="lang"><option>English</option></select>
    `;
    const units = extractUnits(document.body, {
      minTextLength: 2,
      blockMaxChars: 1200,
      targetLang: "zh-CN",
    });
    const btnUnit = units.find((u) => u.container.tagName === "BUTTON");
    const optUnit = units.find((u) => u.container.tagName === "OPTION");
    expect(btnUnit?.text).toBe("Show more options");
    expect(btnUnit?.textOnly).toBe(true);
    expect(optUnit?.text).toBe("English");
    expect(optUnit?.textOnly).toBe(true);
    expect(units.some((u) => u.text === "Edit your public profile.")).toBe(true); // 正文仍正常提取
  });

  it("按钮原位翻译：文字被替换、结构零改动（图标保留、不插元素、不包裹）", async () => {
    document.body.innerHTML = `
      <button id="toggle"><span id="icon"></span>Show more options</button>
    `;
    const engine = makeEngine("bilingual");
    await engine.translateAll();
    await flush();

    const btn = document.querySelector("#toggle") as HTMLButtonElement;
    expect(btn.textContent?.trim()).toBe("【译】Show more options");
    expect(btn.querySelector("#icon")).not.toBeNull(); // 图标子元素保留
    expect(btn.children.length).toBe(1); // 未插入任何译文元素
    expect(btn.nextElementSibling?.classList.contains("it-translated") ?? false).toBe(false);
    expect(btn.closest(".it-wrap")).toBeNull(); // 不被包裹
  });

  it("下拉选项原位翻译（结构不变，选中交互不受影响）", async () => {
    const engine = makeEngine("bilingual");
    await engine.translateAll();
    await flush();

    const opts = Array.from(document.querySelectorAll<HTMLOptionElement>("#lang option"));
    expect(opts[0].textContent).toBe("【译】English");
    expect(opts[1].textContent).toBe("【译】Chinese");
    expect(opts[0].parentElement?.tagName).toBe("SELECT"); // 结构不变
  });

  it("显示模式切换：原文模式恢复控件原文，切回后重新显示译文", async () => {
    const engine = makeEngine("bilingual");
    await engine.translateAll();
    await flush();

    const btn = document.querySelector("#toggle") as HTMLButtonElement;
    expect(btn.textContent?.trim()).toBe("【译】Show more options");

    engine.renderer.setMode("original");
    expect(btn.textContent?.trim()).toBe("Show more options");

    engine.renderer.setMode("translated");
    expect(btn.textContent?.trim()).toBe("【译】Show more options");
  });

  it("一键还原：控件文字恢复原文且标记清除", async () => {
    const engine = makeEngine("bilingual");
    await engine.translateAll();
    await flush();

    const btn = document.querySelector("#toggle") as HTMLButtonElement;
    expect(btn.textContent?.trim()).toBe("【译】Show more options");

    engine.restore();
    expect(btn.textContent?.trim()).toBe("Show more options");
    expect(btn.hasAttribute("data-it-ctl-orig")).toBe(false);
    expect(btn.hasAttribute("data-it-src")).toBe(false);
  });

  it("details/summary 折叠菜单：summary 翻译但保持直接子元素（可收起）", async () => {
    document.body.innerHTML = `
      <details>
        <summary>Options</summary>
        <ul><li>Profile</li><li>Settings</li></ul>
      </details>
    `;
    const engine = makeEngine("bilingual");
    await engine.translateAll();
    await flush();

    const summary = document.querySelector("summary") as HTMLElement;
    expect(summary.parentElement?.tagName).toBe("DETAILS"); // 仍是直接子元素
    expect(summary.closest(".it-wrap")).toBeNull(); // 不被包裹
    // 摘要翻译以行内译文跟在后面
    expect(document.querySelector("details > .it-translated")).not.toBeNull();
    // 菜单内容照常翻译
    expect(document.body.textContent).toContain("【译】");
  });
});

describe("行内链接：<a> 独立替换单元 + 父块保留完整源句（P1 回归修复）", () => {
  const OPTS = { minTextLength: 2, blockMaxChars: 1200, targetLang: "zh-CN" };

  /** 只拼可见文本：跳过被 CSS 隐藏的译文元素与被降级的链接
   *（textContent 会连隐藏文字一起拼，jsdom 里没有真实布局） */
  function visibleOnly(root: HTMLElement): string {
    let out = "";
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        for (let p = n.parentElement; p && p !== root; p = p.parentElement) {
          if (p.classList.contains("it-translated-hidden")) return NodeFilter.FILTER_REJECT;
          if (p.hasAttribute("data-it-orig-hidden")) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n: Node | null;
    while ((n = walker.nextNode())) out += n.textContent ?? "";
    return out;
  }

  it("链接文字拆为锚定 <a> 的独立单元，但父块单元文本保留链接词（API 看到完整源句）", () => {
    document.body.innerHTML = `<div id="card">Read the docs <a href="/d">about the product</a> for more info</div>`;
    const units = extractUnits(document.body, OPTS);
    const aUnit = units.find((u) => u.container.tagName === "A");
    expect(aUnit?.text).toBe("about the product");
    const divUnit = units.find((u) => u.container.id === "card");
    // 送 API 的必须是完整句——剥掉链接词的破碎句（"Read the docs for more info"）是 P1 回归
    expect(divUnit?.text).toBe("Read the docs about the product for more info");
    expect(divUnit?.linkParts?.length).toBe(1);
    expect(divUnit?.linkParts?.[0]?.el).toBe(aUnit?.container);
    expect(divUnit?.linkParts?.[0]?.text).toBe("about the product");
  });

  it("仅译文：整句译文拆段嵌入链接两侧，链接文字原位替换，href 不动仍可点击", async () => {
    document.body.innerHTML = `<p id="t">Contact <a href="/c">our support team</a> anytime.</p>`;
    const engine = makeEngine("translated");
    await engine.translateAll();
    await flush();
    await flush();

    const a = document.querySelector<HTMLAnchorElement>("#t a")!;
    const p = document.querySelector<HTMLElement>("#t")!;
    expect(a.getAttribute("href")).toBe("/c"); // 元素与 href 原样：点击跳转不受影响
    expect(a.firstChild?.textContent).toBe("我们的支持团队"); // 链接文字被译文原位替换
    const hidden = a.querySelector(".it-translated");
    if (hidden) expect(hidden.classList.contains("it-translated-hidden")).toBe(true); // 行内译文隐藏，不重复显示
    // 可见文本 = 整句译文按链接拆段嵌入：完整、零重复、不含任何英文原文片段
    expect(visibleOnly(p)).toBe("联系 我们的支持团队 随时.");
    expect(a.previousSibling?.textContent).toBe("联系 "); // 首段嵌在链接之前
    expect(a.nextSibling?.textContent).toBe(" 随时."); // 尾段嵌在链接之后
  });

  it("仅译文·降级：模型换序导致拆段失配时，整句译文直替 + 隐藏链接防重复", async () => {
    // 「【译】」前缀 mock 保证整句译文不含链接译文——正是拆段失配的场景
    document.body.innerHTML = `<p id="t2">Please read <a href="/y">the license terms</a> carefully.</p>`;
    const engine = makeEngine("translated");
    await engine.translateAll();
    await flush();
    await flush();

    const a = document.querySelector<HTMLAnchorElement>("#t2 a")!;
    const p = document.querySelector<HTMLElement>("#t2")!;
    // 可见文本只有完整整句译文：链接词不重复（原文被剥走的破碎句不会出现）
    expect(visibleOnly(p)).toBe("【译】Please read the license terms carefully.");
    expect(a.hasAttribute("data-it-orig-hidden")).toBe(true); // 失配的链接被隐藏
    expect(a.getAttribute("href")).toBe("/y"); // 元素仍在，切回双语即恢复

    engine.renderer.setMode("bilingual");
    expect(a.hasAttribute("data-it-orig-hidden")).toBe(false); // 双语下链接回来了
    expect(visibleOnly(p)).toContain("Please read"); // 父块原文完整还原
  });

  it("仅译文 → 双语 → 仅译文：原文完整还原，拆段译文可重复嵌入", async () => {
    document.body.innerHTML = `<p id="t">Contact <a href="/c">our support team</a> anytime.</p>`;
    const engine = makeEngine("translated");
    await engine.translateAll();
    await flush();
    await flush();

    engine.renderer.setMode("bilingual");
    const p = document.querySelector<HTMLElement>("#t")!;
    const a = document.querySelector<HTMLAnchorElement>("#t a")!;
    expect(visibleOnly(p)).toContain("Contact"); // 父块原文（链接前文字）完整还原
    expect(visibleOnly(p)).toContain("anytime"); // 链接后文字还原
    expect(visibleOnly(p)).toContain("our support team"); // 链接原文还原（双语下译文另显）

    engine.renderer.setMode("translated");
    expect(a.getAttribute("href")).toBe("/c");
    expect(a.firstChild?.textContent).toBe("我们的支持团队"); // 再次拆段嵌入
    expect(visibleOnly(p)).toBe("联系 我们的支持团队 随时.");

    engine.restore();
    expect(visibleOnly(p)).toBe("Contact our support team anytime."); // 整页还原干净
    expect(a.firstChild?.textContent).toBe("our support team"); // 链接原文也还原
  });
});

describe("图标字体连字文字不翻译（带文字图标被误翻译修复）", () => {
  const OPTS = { minTextLength: 2, blockMaxChars: 1200, targetLang: "zh-CN" };

  it("material-icons span 的字形名（home）不进任何翻译单元", () => {
    document.body.innerHTML = `<p>Click the <span style="font-family: 'Material Icons'">home</span> button to go back.</p>`;
    const units = extractUnits(document.body, OPTS);
    expect(units.every((u) => u.container.tagName !== "SPAN")).toBe(true);
    expect(units.some((u) => u.text.includes("home"))).toBe(false); // 字形名不掺进句子
    expect(units[0]?.text).toBe("Click the button to go back.");
  });

  it("仅译文模式：图标 span 的字形名原样保留（图标不碎），句子的其余部分正常替换", async () => {
    document.body.innerHTML = `<p id="t">Press the <span style="font-family: 'Font Awesome 6 Free'">star</span> icon to favorite.</p>`;
    const engine = makeEngine("translated");
    await engine.translateAll();
    await flush();
    await flush();

    const span = document.querySelector("#t span")!;
    expect(span.textContent).toBe("star"); // 字形名没被动过：连字图标照常渲染
    expect(document.querySelector("#t")!.textContent).toContain("【译】Press the icon to favorite."); // 句子译文完整、不掺 star
  });
});
