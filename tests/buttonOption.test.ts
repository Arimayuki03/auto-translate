// @vitest-environment jsdom
/**
 * 交互控件翻译策略：
 * - <button> / <select> / <option> 属于交互控件，翻译会改变其标签文字或 DOM 结构、
 *   破坏点击展开/收起等原有交互 → 整体排除，不翻译（回归：侧边按钮翻译后无法收起 bug）。
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

describe("交互控件翻译策略", () => {
  it("提取：按钮与下拉选项文字被排除（不参与翻译）", () => {
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
    expect(units.some((u) => u.container.tagName === "BUTTON")).toBe(false);
    expect(units.some((u) => u.container.tagName === "OPTION")).toBe(false);
    expect(units.some((u) => u.text === "Edit your public profile.")).toBe(true); // 正文仍正常提取
  });

  it("按钮不被翻译（交互逻辑保持不变）", async () => {
    const engine = makeEngine("bilingual");
    await engine.translateAll();
    await flush();

    const btn = document.querySelector("#toggle") as HTMLButtonElement;
    expect(btn.textContent?.trim()).toBe("Show more options"); // 原文保留
    expect(btn.nextElementSibling?.classList.contains("it-translated")).toBe(false); // 无译文插入
    expect(btn.closest(".it-wrap")).toBeNull(); // 不被包裹
  });

  it("下拉选项不被翻译", async () => {
    const engine = makeEngine("bilingual");
    await engine.translateAll();
    await flush();

    const opts = Array.from(document.querySelectorAll<HTMLOptionElement>("#lang option"));
    expect(opts[0].textContent).toBe("English");
    expect(opts[1].textContent).toBe("Chinese");
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
