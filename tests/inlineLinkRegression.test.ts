// @vitest-environment jsdom
/**
 * P1 回归（审查会话判定）：正文行内 <a> 拆为独立替换单元后，父块送翻译 API 的
 * 源句曾被剥掉链接文字（"The United States is a country…" → "The is a country…"）。
 * 修复后的口径：API 永远看到完整源句；链接文字作为独立单元原位替换；仅译文渲染
 * 把整句译文按链接译文拆段嵌入，不重复、不破碎、链接可点击。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, uninstallChromeMock } from "./helpers/chromeMock";
import { PageEngine } from "../src/content/engine";
import { Renderer, splitAroundTranslation } from "../src/content/renderer";
import { extractUnits } from "../src/content/extractor";
import type { Settings } from "../src/shared/types";

const SENT = "The United States is a country in North America.";

function makeSettings(displayMode: "bilingual" | "translated"): Settings {
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
      displayMode,
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

let sentTexts: string[];

beforeEach(() => {
  sentTexts = [];
  const sendMessage = vi.fn(async (msg: { type: string; texts?: string[]; id?: string }) => {
    if (msg?.type === "translate") {
      sentTexts.push(...(msg.texts ?? []));
      // 词典式 mock：整句译文包含词组译文（真实模型的行为），拆段才能命中
      const results = (msg.texts ?? []).map((t) => {
        if (t === SENT) return "美国是一个北美洲的国家。";
        if (t === "United States") return "美国";
        if (t === "North America") return "北美洲";
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
  return new PageEngine(renderer, makeSettings(mode));
}

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

describe("P1 回归：行内链接不破坏父块源句", () => {
  const OPTS = { minTextLength: 2, blockMaxChars: 1200, targetLang: "zh-CN" };

  it("维基百科例句：一段两个链接，父块单元保留完整句 + 两个有序 linkParts", () => {
    document.body.innerHTML = `<p id="w">The <a href="/w/USA">United States</a> is a country in <a href="/w/NA">North America</a>.</p>`;
    const units = extractUnits(document.body, OPTS);
    const pUnit = units.find((u) => u.container.id === "w");
    expect(pUnit?.text).toBe(SENT); // 完整源句——曾被剥成 "The is a country in North America."
    expect(pUnit?.linkParts?.map((p) => p.text)).toEqual(["United States", "North America"]);
    const linkUnits = units.filter((u) => u.container.tagName === "A");
    expect(linkUnits.map((u) => u.text)).toEqual(["United States", "North America"]);
    expect(units.length).toBe(3);
  });

  it("送 API 的请求文本必须含完整源句，绝不出现破碎句", async () => {
    document.body.innerHTML = `<p id="w">The <a href="/w/USA">United States</a> is a country in <a href="/w/NA">North America</a>.</p>`;
    const engine = makeEngine("translated");
    await engine.translateAll();
    await flush();
    await flush();

    expect(sentTexts).toContain(SENT);
    expect(sentTexts.some((t) => t === "The is a country in North America.")).toBe(false);
  });

  it("仅译文：整句译文按两个链接拆段嵌入——完整、零重复、都可点击", async () => {
    document.body.innerHTML = `<p id="w">The <a href="/w/USA">United States</a> is a country in <a href="/w/NA">North America</a>.</p>`;
    const engine = makeEngine("translated");
    await engine.translateAll();
    await flush();
    await flush();

    const p = document.querySelector<HTMLElement>("#w")!;
    const usa = document.querySelector<HTMLAnchorElement>('a[href="/w/USA"]')!;
    const na = document.querySelector<HTMLAnchorElement>('a[href="/w/NA"]')!;
    expect(visibleOnly(p)).toBe("美国是一个北美洲的国家。"); // 与整句译文一字不差：不重不漏
    expect(usa.firstChild?.textContent).toBe("美国");
    expect(usa.getAttribute("href")).toBe("/w/USA");
    expect(na.firstChild?.textContent).toBe("北美洲");
    expect(na.getAttribute("href")).toBe("/w/NA");
    expect(usa.hasAttribute("data-it-orig-hidden")).toBe(false); // 走的是拆段而非降级隐藏

    engine.restore();
    expect(visibleOnly(p)).toBe(SENT); // 一键还原干净
  });

  it("双语：原文一字不动（链接保持原样），译文整句完整另显", async () => {
    document.body.innerHTML = `<p id="w">The <a href="/w/USA">United States</a> is a country in <a href="/w/NA">North America</a>.</p>`;
    const engine = makeEngine("bilingual");
    await engine.translateAll();
    await flush();
    await flush();

    const p = document.querySelector<HTMLElement>("#w")!;
    expect(p.textContent).toContain("The "); // 父块原文未被原位替换
    expect(document.querySelector('a[href="/w/USA"]')!.getAttribute("href")).toBe("/w/USA");
    expect(document.body.textContent).toContain("美国是一个北美洲的国家。"); // 整句译文（完整源句翻出来的）
    engine.restore();
    expect(document.querySelector("#w")!.textContent).toBe(SENT);
  });
});

describe("splitAroundTranslation 匹配口径", () => {
  it("精确/忽略空白/大小写折叠/尾标点剥离都能命中", () => {
    expect(splitAroundTranslation("Hello brave world", ["brave"])).toEqual(["Hello ", " world"]);
    expect(splitAroundTranslation("Please  contact   us today", ["contact us"])).toEqual([
      "Please  ",
      " today",
    ]);
    expect(splitAroundTranslation("Read The Book now", ["the book"])).toEqual(["Read ", " now"]);
    expect(splitAroundTranslation("Visit 我们的条款 here", ["我们的条款."])).toEqual([
      "Visit ",
      " here",
    ]);
  });

  it("多链接按文档序拆分；失配返回 null（调用方走降级）", () => {
    expect(splitAroundTranslation("美国是一个北美洲的国家。", ["美国", "北美洲"])).toEqual([
      "",
      "是一个",
      "的国家。",
    ]);
    // 链接译文在句中顺序颠倒（模型换序）：不猜测，交降级
    expect(splitAroundTranslation("美国是一个北美洲的国家。", ["北美洲", "美国"])).toBeNull();
    expect(splitAroundTranslation("完全无关的译文", ["美国"])).toBeNull();
  });
});
