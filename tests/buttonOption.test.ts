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
import { PageEngine } from "../src/content/engine";
import { Renderer } from "../src/content/renderer";
import { extractUnits } from "../src/content/extractor";
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
    },
    sites: { whitelist: [], blacklist: [] },
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
      return { id: msg.id, ok: true, results: (msg.texts ?? []).map((t) => `【译】${t}`) };
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
