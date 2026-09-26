// @vitest-environment jsdom
/**
 * 自动翻译 vs 「按站点保存/还原翻译设置」的排查测试：
 * 1. 手动还原后，自动翻译（切回前台）不应再把本页译回来；
 * 2. 按站点还原的 targetLang / displayMode 应被自动翻译正确使用（无冲突）；
 * 3. 禁用自动翻译按「子网页（host+pathname）」粒度，不波及其他子页。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uninstallChromeMock } from "./helpers/chromeMock";
import { PageEngine } from "../src/content/engine";
import { Renderer } from "../src/content/renderer";
import {
  __resetDisabledCache,
  currentPageKey,
  getDisabledPages,
  getPerSite,
  setPageDisabled,
} from "../src/content/perSite";
import type { Settings } from "../src/shared/types";

const HOST = "github.com";

function makeSettings(overrides: Partial<Settings["translate"]> = {}): Settings {
  return {
    enabled: true,
    api: {
      format: "openai",
      baseUrl: "http://test",
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
      ...overrides,
    },
    sites: { whitelist: [], blacklist: [] },
    tts: { enabled: true, voice: "", rate: 0 },
    security: { encryptApiKey: false, sensitivePages: false },
    cache: { enabled: true, maxEntries: 500 },
  };
}

let sendMessage: ReturnType<typeof vi.fn>;
let storageGet: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetDisabledCache(); // 清掉 perSite 模块级内存缓存，避免测试间串扰
  document.body.innerHTML = "<h1>个人资料</h1><p>编辑你的公开资料。</p>";
  sendMessage = vi.fn(async (msg: { type: string; texts?: string[]; id?: string }) => {
    if (msg?.type === "translate") {
      return { id: msg.id, ok: true, results: (msg.texts ?? []).map((t) => `【译】${t}`) };
    }
    if (msg?.type === "check-cache") return { cachedCount: 0 };
    return undefined;
  });
  storageGet = vi.fn(async () => ({}));
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { sendMessage },
    storage: { local: { get: storageGet, set: vi.fn(async () => undefined) } },
  } as unknown as typeof chrome;
});

afterEach(() => {
  uninstallChromeMock();
  __resetDisabledCache();
  vi.restoreAllMocks();
});

function makeEngine(settings: Settings) {
  const renderer = new Renderer(settings.translate.displayMode);
  renderer.setMode(settings.translate.displayMode);
  return new PageEngine(renderer, settings);
}

/** translateAll 内部把翻译任务 fire-and-forget：提取/调度是多层异步链（chunked 提取按
 *  时间片让出），固定轮数的 flush 在系统高负载下会提前返回造成偶发失败，改为轮询等待 */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function translateCallCount(): number {
  return sendMessage.mock.calls.filter(([m]) => m?.type === "translate").length;
}

describe("自动翻译 vs 还原", () => {
  it("手动还原后标记 restoredByUser=true，自动翻译不该再译回来", async () => {
    const engine = makeEngine(makeSettings());

    await engine.translateAll();
    expect(engine.restoredByUser).toBe(false);

    engine.restore();
    expect(engine.restoredByUser).toBe(true); // 还原后应阻止自动翻译重译

    // 自动触发路径（无用户意图）不清除还原标记：还原意愿得以保留
    await engine.translateAll();
    expect(engine.restoredByUser).toBe(true);

    // 用户再次主动翻译（显式意图入口）→ 标记清除
    await engine.translateAll(true);
    expect(engine.restoredByUser).toBe(false);
  });

  it("切回前台重译会被 restoredByUser 阻止（回归：还原后被自动翻译顶掉）", async () => {
    const engine = makeEngine(makeSettings());
    await engine.translateAll();
    engine.restore();

    // 模拟 main() 的 visibilitychange 门控逻辑：restoredByUser 时不调用 translateAll
    const shouldTranslateOnVisible =
      document.visibilityState === "visible" && !engine.restoredByUser;
    expect(shouldTranslateOnVisible).toBe(false);
  });
});

describe("按站点还原翻译设置 vs 自动翻译", () => {
  it("还原的 targetLang 会被自动翻译使用（请求语言一致，无冲突）", async () => {
    // 该站已保存 targetLang=en
    storageGet.mockImplementation(async (key: string) =>
      key === "it-site:github.com"
        ? { "it-site:github.com": { targetLang: "en", displayMode: "bilingual" } }
        : {}
    );
    const per = await getPerSite(HOST);
    expect(per?.targetLang).toBe("en");

    const settings = makeSettings();
    if (per) {
      settings.translate.targetLang = per.targetLang;
      settings.translate.displayMode = per.displayMode;
    }
    const engine = makeEngine(settings);
    expect(engine.targetLanguage).toBe("en");

    await engine.translateAll();
    await waitFor(() => translateCallCount() > 0);
    // 自动翻译发出的请求必须用还原后的语言
    const translateCalls = sendMessage.mock.calls.filter(([m]) => m?.type === "translate");
    expect(translateCalls.every(([m]) => m.targetLang === "en")).toBe(true);
    await waitFor(() => (document.body.textContent ?? "").includes("【译】"));
  });

  it("还原的 displayMode 会被渲染器使用（仅译文模式生效）", async () => {
    storageGet.mockImplementation(async (key: string) =>
      key === "it-site:github.com"
        ? { "it-site:github.com": { targetLang: "en", displayMode: "translated" } }
        : {}
    );
    const per = await getPerSite(HOST);
    const settings = makeSettings();
    if (per) {
      settings.translate.targetLang = per.targetLang;
      settings.translate.displayMode = per.displayMode;
    }
    const engine = makeEngine(settings);
    expect(engine.renderer.getMode()).toBe("translated");

    await engine.translateAll();
    // 仅译文模式：原文文字被原位替换为译文（链接/结构保留，不再是 CSS 藏整块）
    await waitFor(() => document.querySelectorAll(".it-translated.it-done").length > 0);
    expect(document.querySelectorAll(".it-translated.it-done").length).toBeGreaterThan(0);
    // 原文已被替换：容器文字以译文开头（mock 译文 = 【译】+原文；双语下则应以原文开头）
    expect((document.querySelector("h1")!.textContent ?? "").trimStart()).toMatch(/^【译】/);
    expect((document.querySelector("p")!.textContent ?? "").trimStart()).toMatch(/^【译】/);
  });

  it("自动翻译本身不写入 per-site 设置（无写冲突）", async () => {
    const engine = makeEngine(makeSettings());
    await engine.translateAll();
    // 自动翻译完成后，不应有任何 savePerSite 调用
    const setMock = (
      globalThis as unknown as { chrome: { storage: { local: { set: ReturnType<typeof vi.fn> } } } }
    ).chrome.storage.local.set;
    expect(setMock).not.toHaveBeenCalled();
  });

  it("禁用自动翻译按子页（host+pathname）粒度：一个子页禁用不影响其它子页", async () => {
    // 用户只还原了 /settings/security 这一个子页
    await setPageDisabled("github.com/settings/security", true);

    const disabled = await getDisabledPages();
    expect(disabled.has("github.com/settings/security")).toBe(true);
    expect(disabled.has("github.com/settings/profile")).toBe(false);
    expect(disabled.has("github.com/settings/admin")).toBe(false);

    // 复刻 main() 的 isPageDisabled 判断：只命中被还原的那个子页
    const isPageDisabledFor = (path: string): boolean => disabled.has("github.com" + path);
    expect(isPageDisabledFor("/settings/security")).toBe(true);
    expect(isPageDisabledFor("/settings/profile")).toBe(false); // 其它子页不受影响
    expect(isPageDisabledFor("/settings/admin")).toBe(false);
  });

  it("setPageDisabled 持久化且可移除（手动翻译后恢复）", async () => {
    const setMock = vi.fn(async () => undefined);
    (
      globalThis as unknown as { chrome: { storage: { local: { set: typeof setMock } } } }
    ).chrome.storage.local.set = setMock;

    await setPageDisabled("github.com/settings/security", true);
    expect(await getDisabledPages()).toContain("github.com/settings/security");

    await setPageDisabled("github.com/settings/security", false);
    expect((await getDisabledPages()).has("github.com/settings/security")).toBe(false);
  });

  it("currentPageKey 区分同一站点的不同子页", async () => {
    history.replaceState({}, "", "https://github.com/settings/security");
    expect(currentPageKey()).toBe("github.com/settings/security");

    history.replaceState({}, "", "https://github.com/settings/profile");
    expect(currentPageKey()).toBe("github.com/settings/profile");
  });
});
