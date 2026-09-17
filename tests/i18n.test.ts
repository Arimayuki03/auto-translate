/**
 * UI 文案国际化（i18n）单元测试：
 * - 语言判定：zh 开头 → 中文，其他 → 英文；chrome.i18n 优先于 navigator；
 * - 判定结果缓存，不随后续环境变化抖动；__setUiLang 可覆盖 / 恢复；
 * - t() 按当前语言取值：字符串、模板函数、缺键回退（en 表缺键 → zh 表 → key 本身）；
 * - zh/en 两表键集合一致（防止单边漏译，直接对源码双表做键集合 diff）。
 * 语言判定结果缓存在模块级变量中，每个用例通过 vi.resetModules + 动态 import 隔离。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ChromeShape = { i18n?: { getUILanguage?: () => string } };

function setChromeI18n(uiLang?: string): void {
  (globalThis as { chrome?: unknown }).chrome = uiLang
    ? ({ i18n: { getUILanguage: () => uiLang } } satisfies ChromeShape)
    : {};
}

beforeEach(() => {
  vi.resetModules();
  setChromeI18n();
});

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.unstubAllGlobals();
});

/** 每个用例重新加载模块，避免语言判定缓存串扰 */
async function loadModule(): Promise<typeof import("../src/shared/i18n")> {
  return import("../src/shared/i18n");
}

describe("语言判定", () => {
  it("chrome.i18n zh 开头 → 中文", async () => {
    setChromeI18n("zh-CN");
    const { t } = await loadModule();
    expect(t("translate")).toBe("译");
  });

  it("chrome.i18n 非 zh → 英文", async () => {
    setChromeI18n("en-US");
    const { t } = await loadModule();
    expect(t("translate")).toBe("T");
    expect(t("restore")).toBe("Restore");
  });

  it("无 chrome 时回退 navigator.languages", async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    vi.stubGlobal("navigator", { languages: ["ja-JP", "en"], language: "ja" });
    const { t } = await loadModule();
    expect(t("translate")).toBe("T");
  });

  it("navigator 含 zh → 中文", async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    vi.stubGlobal("navigator", { languages: ["zh-TW"], language: "zh-TW" });
    const { t } = await loadModule();
    expect(t("translate")).toBe("译");
  });

  it("navigator.languages 缺失时回退 navigator.language", async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    vi.stubGlobal("navigator", { language: "en-GB" });
    const { t } = await loadModule();
    expect(t("translate")).toBe("T");
  });

  it("判定结果缓存：初次英文后即使 navigator 改变仍保持英文", async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    vi.stubGlobal("navigator", { languages: ["en"], language: "en" });
    const mod = await loadModule();
    expect(mod.t("translate")).toBe("T");
    vi.stubGlobal("navigator", { languages: ["zh-CN"], language: "zh-CN" });
    expect(mod.t("restore")).toBe("Restore");
  });

  it("__setUiLang 覆盖判定；null 恢复自动判定", async () => {
    const mod = await loadModule();
    mod.__setUiLang("en");
    expect(mod.t("translate")).toBe("T");
    mod.__setUiLang("zh");
    expect(mod.t("translate")).toBe("译");
    // 恢复自动判定：chrome.i18n = en-US → 英文
    setChromeI18n("en-US");
    mod.__setUiLang(null);
    expect(mod.t("restore")).toBe("Restore");
  });
});

describe("t() 取值与回退", () => {
  it("模板函数按参数展开（中文）", async () => {
    const mod = await loadModule();
    mod.__setUiLang("zh");
    expect(mod.t("copiedCount", 3)).toBe("已复制 3 段");
    expect(mod.t("partialCount", 5, 1, "超时")).toBe("共 5 段完成，1 段失败：超时");
    expect(mod.t("partialCount", 5, 0, "")).toBe("共 5 段完成，0 段失败");
  });

  it("模板函数按参数展开（英文）", async () => {
    const mod = await loadModule();
    mod.__setUiLang("en");
    expect(mod.t("copiedCount", 3)).toBe("Copied 3 segments");
    expect(mod.t("doneCount", 7)).toBe("7 segments done");
  });

  it("未知 key 返回 key 本身（缺省回退链终点）", async () => {
    const mod = await loadModule();
    mod.__setUiLang("en");
    expect(mod.t("totally-missing-key")).toBe("totally-missing-key");
    mod.__setUiLang("zh");
    expect(mod.t("totally-missing-key")).toBe("totally-missing-key");
  });
});

describe("zh/en 两表键集合一致（单边漏译检测）", () => {
  it("两表键完全对齐且规模合理", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../src/shared/i18n.ts", import.meta.url),
      "utf-8"
    );
    const zhStart = source.indexOf("const zh: Dict");
    const enStart = source.indexOf("const en: Dict");
    const langDoc = source.indexOf("/** 当前 UI 语言");
    const zhBlock = source.slice(zhStart, enStart);
    const enBlock = source.slice(enStart, langDoc);
    const keysOf = (block: string) =>
      new Set([...block.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]));
    const zhKeys = keysOf(zhBlock);
    const enKeys = keysOf(enBlock);
    expect(zhKeys.size).toBeGreaterThan(40);
    expect([...zhKeys].filter((k) => !enKeys.has(k))).toEqual([]);
    expect([...enKeys].filter((k) => !zhKeys.has(k))).toEqual([]);
  });
});
