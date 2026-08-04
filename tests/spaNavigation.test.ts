// @vitest-environment jsdom
/**
 * SPA 路由导航集成测试：模拟 GitHub settings 式换页（pushState + <body> 整体替换），
 * 验证多次切换子页后译文仍保持（不还原成原文）。回归测试：切换几个子网页后自动还原 bug。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageEngine } from "../src/content/engine";
import { PageObserver } from "../src/content/observer";
import { Renderer } from "../src/content/renderer";
import { setupSpaNavigation } from "../src/content/navigation";
import type { Settings } from "../src/shared/types";

const PAGES = {
  profile: {
    url: "https://github.com/settings/profile",
    html: "<h1>Profile settings</h1><p>Edit your public profile.</p><p>Your name is shown publicly.</p>",
  },
  admin: {
    url: "https://github.com/settings/admin",
    html: "<h1>Admin settings</h1><p>Manage organization access.</p><p>Control repository permissions.</p>",
  },
  security: {
    url: "https://github.com/settings/security",
    html: "<h1>Security settings</h1><p>Set up two-factor authentication.</p><p>Manage active sessions.</p>",
  },
  notifications: {
    url: "https://github.com/settings/notifications",
    html: "<h1>Notifications settings</h1><p>Choose how you receive updates.</p><p>Configure email preferences.</p>",
  },
} as const;

function makeSettings(): Settings {
  return {
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
    },
    sites: { whitelist: [], blacklist: [] },
    security: { encryptApiKey: false, sensitivePages: true },
    cache: { enabled: true, maxEntries: 500 },
  };
}

/** 把页面渲染成新的 <body>（Turbo 式整体替换），触发 documentElement 上的 mutation */
function swapBody(html: string): void {
  const newBody = document.createElement("body");
  newBody.innerHTML = html;
  document.body.replaceWith(newBody);
}

/** 已渲染完成的译文数量 */
function doneCount(): number {
  return document.querySelectorAll(".it-translated.it-done").length;
}

function makeHarness(overrides: {
  isSensitive?: () => boolean;
  isPageDisabled?: () => boolean;
} = {}) {
  const settings = makeSettings();
  const renderer = new Renderer(settings.translate.displayMode);
  const engine = new PageEngine(renderer, settings);
  const observer = new PageObserver(engine);
  const isSensitive = overrides.isSensitive ?? (() => false);
  const isPageDisabled = overrides.isPageDisabled ?? (() => false);
  observer.isSensitive = isSensitive;
  observer.isPageDisabled = isPageDisabled;
  setupSpaNavigation({
    engine,
    renderer,
    observer,
    autoTranslate: true,
    isSensitive,
    isPageDisabled,
    ensureToolbar: () => {},
  });
  lastHarness = { observer };
  return { engine, observer, renderer };
}

/** 上一个测试遗留的 observer / history 补丁，需要在本测试开始前清理（jsdom 的 window 跨测试共享） */
let lastHarness: { observer: PageObserver } | null = null;
let origPushState: typeof history.pushState;
let origReplaceState: typeof history.replaceState;

async function flush(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  // 清理上一个测试遗留：断开其 MutationObserver，恢复被它补丁的 history
  lastHarness?.observer.disconnect();
  lastHarness = null;
  if (origPushState) history.pushState = origPushState;
  if (origReplaceState) history.replaceState = origReplaceState;

  vi.useFakeTimers();
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  document.body.innerHTML = PAGES.profile.html;

  // jsdom 未实现的方法
  document.elementFromPoint = () => null;

  // Mock chrome.*
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage: vi.fn(async (msg: { type: string; texts?: string[]; id?: string }) => {
        if (msg?.type === "translate") {
          return { id: msg.id, ok: true, results: (msg.texts ?? []).map((t) => `【译】${t}`) };
        }
        if (msg?.type === "check-cache") {
          return { cachedCount: 0 };
        }
        return undefined;
      }),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
  } as unknown as typeof chrome;

  origPushState = history.pushState;
  origReplaceState = history.replaceState;
});

afterEach(() => {
  lastHarness?.observer.disconnect();
  lastHarness = null;
  if (origPushState) history.pushState = origPushState;
  if (origReplaceState) history.replaceState = origReplaceState;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SPA 换页翻译", () => {
  it("自动翻译首次加载", async () => {
    const { engine } = makeHarness();

    await engine.translateAll();
    await flush(10);

    expect(engine.state).not.toBe("off");
    expect(doneCount()).toBeGreaterThan(0);
  });

  it("连续切换多个子页后仍保持翻译（回归：自动还原 bug）", async () => {
    const { engine } = makeHarness();

    // 首次加载
    await engine.translateAll();
    await flush(10);
    expect(doneCount()).toBeGreaterThan(0);

    // 连续切换子页（pushState + body 整体替换）
    const order = ["admin", "security", "notifications", "admin", "profile"] as const;
    for (const name of order) {
      const page = PAGES[name];
      history.pushState({}, "", page.url);
      swapBody(page.html);
      // 等导航延迟重译(200ms) + observer 防抖(300ms) + 异步翻译完成；再留余量验证不闪回原文
      await flush(600);
      expect(engine.state).not.toBe("off");
      expect(doneCount(), `切到 ${name} 后译文应存在`).toBeGreaterThan(0);
    }

    // 最终页面必须保持翻译，未还原成原文
    expect(engine.hasTranslated()).toBe(true);
    expect(document.body.innerHTML).toContain("【译】");
    expect(doneCount()).toBeGreaterThan(0);
  });

  it("快速连续切换（间隔 < 防抖窗口）最终页面保持翻译", async () => {
    const { engine } = makeHarness();

    await engine.translateAll();
    await flush(10);
    expect(doneCount()).toBeGreaterThan(0);

    // 快速连点：pushState 与 body 替换在 300ms 内连续发生多次
    const order = ["admin", "security"] as const;
    for (const name of order) {
      history.pushState({}, "", PAGES[name].url);
      swapBody(PAGES[name].html);
      await flush(30); // 每个导航只给 30ms，下一个导航立刻跟上
    }
    await flush(1000); // 全部信号落定后，最后一次导航的重译完成

    expect(engine.state).not.toBe("off");
    expect(doneCount(), "快速切换后译文应存在").toBeGreaterThan(0);
  });

  it("body 被整体替换但 URL 未变（表单重渲染）也应重译", async () => {
    const { engine } = makeHarness();

    await engine.translateAll();
    await flush(10);
    expect(doneCount()).toBeGreaterThan(0);

    // 同一 URL 下 body 被替换（如提交表单后的 Turbo 重渲染）
    const oldUrl = location.href;
    swapBody(PAGES.admin.html);
    await flush(1200);

    expect(engine.state).not.toBe("off");
    expect(doneCount(), "同 URL 的 body 替换后应重译").toBeGreaterThan(0);
    expect(document.body.innerHTML).toContain("【译】");
    expect(location.href).toBe(oldUrl);
  });

  it("body 被整体替换后工具条应重建（即使是被 pushState 已处理的同一导航）", async () => {
    const ensureCalls: string[] = [];
    const settings = makeSettings();
    const renderer = new Renderer(settings.translate.displayMode);
    const engine = new PageEngine(renderer, settings);
    const observer = new PageObserver(engine);
    // 模拟工具条：记录 ensureToolbar 调用时机，并模拟"工具条随 body 一起消失"的检查
    setupSpaNavigation({
      engine,
      renderer,
      observer,
      autoTranslate: true,
      isSensitive: () => false,
      isPageDisabled: () => false,
      ensureToolbar: () => {
        ensureCalls.push(location.href);
      },
    });
    lastHarness = { observer };

    await engine.translateAll();
    await flush(10);
    ensureCalls.length = 0; // 清掉初始调用

    // pushState + body 整体替换（同一导航被 pushState 和 observer 双触发）
    history.pushState({}, "", PAGES.admin.url);
    swapBody(PAGES.admin.html);
    await flush(600);

    // 同一导航的去重路径也要调用 ensureToolbar（body 换了，工具条没了）
    expect(ensureCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("进入敏感页（含 password/2fa 等）不自动翻译，离开后恢复", async () => {
    // isSensitive 按 URL 动态判断：路径含 password 视为凭据页
    const isSensitive = (): boolean => /(password|2fa)/.test(location.pathname);
    const { engine } = makeHarness({ isSensitive });

    // 普通页：正常翻译
    await engine.translateAll();
    await flush(10);
    expect(doneCount()).toBeGreaterThan(0);

    // 进入密码页（pushState + body 整体替换）→ 不应翻译
    history.pushState({}, "", "https://github.com/settings/account/password");
    swapBody("<h1>Change password</h1><p>Enter your current password.</p>");
    await flush(600);
    expect(doneCount(), "敏感页不应翻译").toBe(0);
    expect(document.body.innerHTML).not.toContain("【译】");

    // 离开敏感页回到普通页 → 恢复翻译
    history.pushState({}, "", "https://github.com/settings/profile");
    swapBody(PAGES.profile.html);
    await flush(600);
    expect(doneCount(), "离开敏感页后应恢复翻译").toBeGreaterThan(0);
    expect(engine.hasTranslated()).toBe(true);
  });

  it("observer 在敏感页不提取新内容（isSensitive 门控）", async () => {
    const isSensitive = (): boolean => true;
    const { engine } = makeHarness({ isSensitive });

    // 普通加载后手动翻译一页（绕过自动翻译门控，模拟之前已翻译）
    await engine.translateAll();
    await flush(10);
    expect(doneCount()).toBeGreaterThan(0);

    // 换页到敏感内容：observer 与导航都不应再翻译新内容
    history.pushState({}, "", "https://github.com/settings/profile");
    swapBody("<h1>Profile</h1><p>Some new text that appeared.</p>");
    await flush(600);

    expect(document.body.innerHTML).not.toContain("【译】");
    expect(doneCount()).toBe(0);
    // 引擎仍可用（状态不被误置为 off），只是本页不译
    expect(engine.state).not.toBe("off");
  });

  it("一个子页被禁用，其它子页仍自动翻译（回归：子页粒度）", async () => {
    // 只有 /settings/security 被用户「还原」过 → 该子页禁用自动翻译
    const isPageDisabled = (): boolean => location.pathname === "/settings/security";
    const { engine } = makeHarness({ isPageDisabled });

    // 初始在 profile（未禁用）→ 正常翻译
    await engine.translateAll();
    await flush(10);
    expect(doneCount()).toBeGreaterThan(0);

    // 切到被禁用的 security → 不翻译，引擎回到未翻译态
    history.pushState({}, "", PAGES.security.url);
    swapBody(PAGES.security.html);
    await flush(600);
    expect(doneCount(), "被禁用的子页不应翻译").toBe(0);
    expect(document.body.innerHTML).not.toContain("【译】");
    expect(engine.state).toBe("off");

    // 切到未禁用的 admin → 恢复自动翻译
    history.pushState({}, "", PAGES.admin.url);
    swapBody(PAGES.admin.html);
    await flush(600);
    expect(doneCount(), "其它子页仍应自动翻译").toBeGreaterThan(0);
    expect(engine.state).not.toBe("off");
  });
});
