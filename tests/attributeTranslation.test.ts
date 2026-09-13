// @vitest-environment jsdom
/**
 * HTML 属性翻译回归测试（placeholder / title / alt / aria-label）：
 * - 四类属性批量翻译并保存原文标记（data-it-attr-orig / data-it-attr-done）；
 * - 一键还原恢复全部属性原文；
 * - 跳过我们的 UI、aria-hidden、translate=no、目标语言文本；
 * - 开关关闭时不翻译。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PageEngine } from "../src/content/engine";
import { Renderer } from "../src/content/renderer";
import type { Settings } from "../src/shared/types";

function makeSettings(overrides?: { translateAttributes?: boolean }): Settings {
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
      autoTranslate: false,
      autoDetectSource: true,
      minTextLength: 2,
      blockMaxChars: 1200,
      translateOnSelect: true,
      translateInput: true,
      viewportLazy: false,
      terminology: [],
      translateAttributes: overrides?.translateAttributes ?? true,
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

function makeEngine(settings?: Settings): PageEngine {
  return new PageEngine(new Renderer("bilingual", "zh-CN"), settings ?? makeSettings());
}

beforeEach(() => {
  mockChrome();
  document.body.innerHTML = "";
});

describe("HTML 属性翻译", () => {
  it("placeholder / title / alt / aria-label 批量翻译并保存原文", async () => {
    document.body.innerHTML = `
      <input id="a" placeholder="Search here" />
      <button id="b" title="Delete item">X</button>
      <img id="c" alt="A red cat" />
      <span id="d" aria-label="Close dialog">×</span>`;
    const engine = makeEngine();
    await engine.translateAttributes();

    // 一次批译请求携带全部去重后的文本
    const translateCall = sendMessage.mock.calls.find(
      (c: [{ type: string }]) => c[0]?.type === "translate"
    ) as [{ texts: string[] }] | undefined;
    expect(translateCall?.[0].texts).toEqual([
      "Search here",
      "Delete item",
      "A red cat",
      "Close dialog",
    ]);

    const a = document.getElementById("a") as HTMLInputElement;
    const b = document.getElementById("b")!;
    const c = document.getElementById("c") as HTMLImageElement;
    const d = document.getElementById("d")!;
    expect(a.getAttribute("placeholder")).toBe("【译】Search here");
    expect(b.getAttribute("title")).toBe("【译】Delete item");
    expect(c.alt).toBe("【译】A red cat");
    expect(d.getAttribute("aria-label")).toBe("【译】Close dialog");
    // 原文保存 + 完成标记
    expect(JSON.parse(a.getAttribute("data-it-attr-orig") ?? "{}")).toEqual({
      placeholder: "Search here",
    });
    for (const el of [a, b, c, d]) expect(el.hasAttribute("data-it-attr-done")).toBe(true);
  });

  it("一键还原恢复全部属性原文并移除标记", async () => {
    document.body.innerHTML = `<input id="a" placeholder="Search here" /><img id="c" alt="A red cat" />`;
    const engine = makeEngine();
    await engine.translateAttributes();
    engine.restore();
    const a = document.getElementById("a") as HTMLInputElement;
    expect(a.placeholder).toBe("Search here");
    expect(a.hasAttribute("data-it-attr-orig")).toBe(false);
    expect(a.hasAttribute("data-it-attr-done")).toBe(false);
    expect((document.getElementById("c") as HTMLImageElement).alt).toBe("A red cat");
  });

  it("跳过我们的 UI、aria-hidden、translate=no 子树", async () => {
    document.body.innerHTML = `
      <div data-it-ui><input id="ours" placeholder="Internal only" /></div>
      <div aria-hidden="true"><span id="hid" title="Hidden tip">h</span></div>
      <span id="kept" translate="no" title="Keep original">k</span>
      <span id="ok" title="Translate me">t</span>`;
    const engine = makeEngine();
    await engine.translateAttributes();
    expect(document.getElementById("ours")!.getAttribute("placeholder")).toBe("Internal only");
    expect(document.getElementById("hid")!.getAttribute("title")).toBe("Hidden tip");
    expect(document.getElementById("kept")!.getAttribute("title")).toBe("Keep original");
    expect(document.getElementById("ok")!.getAttribute("title")).toBe("【译】Translate me");
  });

  it("目标语言文本跳过（无候选时不发请求）", async () => {
    document.body.innerHTML = `<input id="a" placeholder="搜索商品" /><span id="b" title="中文标题">字</span>`;
    const engine = makeEngine();
    await engine.translateAttributes();
    expect(sendMessage).not.toHaveBeenCalled();
    expect((document.getElementById("a") as HTMLInputElement).placeholder).toBe("搜索商品");
  });

  it("translateAttributes = false 时整体关闭", async () => {
    document.body.innerHTML = `<input id="a" placeholder="Search here" />`;
    const engine = makeEngine(makeSettings({ translateAttributes: false }));
    await engine.translateAttributes();
    expect(sendMessage).not.toHaveBeenCalled();
    expect((document.getElementById("a") as HTMLInputElement).placeholder).toBe("Search here");
  });

  it("同一元素多个属性分别保存原文", async () => {
    document.body.innerHTML = `<img id="i" alt="A red cat" title="Red cat photo" />`;
    const engine = makeEngine();
    await engine.translateAttributes();
    const i = document.getElementById("i")!;
    expect(JSON.parse(i.getAttribute("data-it-attr-orig") ?? "{}")).toEqual({
      alt: "A red cat",
      title: "Red cat photo",
    });
    expect(i.getAttribute("alt")).toBe("【译】A red cat");
    expect(i.getAttribute("title")).toBe("【译】Red cat photo");
  });
});
