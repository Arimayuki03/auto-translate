// @vitest-environment jsdom
/**
 * 第五轮审查回归：插件总开关链路与浮层挂载。
 * J-1：restoreForSwitchOff 不遗留「用户还原过」标记（后台标签页关开一轮后
 *      切回前台 visibilitychange 路径必须仍能补译）。
 * J-2：watchMasterSwitchReopen 消费「开启」即注销；installMasterSwitchSync
 *      只响应 enabled 翻转，且装配完成后用快照回填错过的事件。
 * J-3：工具条挂 <html> 下而非 body（body 带 transform 的站点 fixed 包含块失真，
 *      见 placement.ts）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uninstallChromeMock } from "./helpers/chromeMock";
import { PageEngine } from "../src/content/engine";
import { Renderer } from "../src/content/renderer";
import { Toolbar } from "../src/content/toolbar";
import {
  installMasterSwitchSync,
  watchMasterSwitchReopen,
} from "../src/content/masterSwitch";
import type { Settings } from "../src/shared/types";

function makeSettings(): Settings {
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
    },
    sites: { whitelist: [], blacklist: [] },
    tts: { enabled: true, voice: "", rate: 0 },
    security: { encryptApiKey: false, sensitivePages: false },
    cache: { enabled: true, maxEntries: 500 },
  };
}

type Listener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string
) => void;

let listeners: Listener[];
let store: Record<string, unknown>;

beforeEach(() => {
  listeners = [];
  store = {};
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { sendMessage: vi.fn(async () => undefined) },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => Object.assign(store, obj)),
      },
      onChanged: {
        addListener: (fn: Listener) => listeners.push(fn),
        removeListener: (fn: Listener) => {
          listeners = listeners.filter((f) => f !== fn);
        },
      },
    },
  } as unknown as typeof chrome;
});

afterEach(() => {
  uninstallChromeMock();
  vi.restoreAllMocks();
});

function fireChange(newValue: unknown, oldValue: unknown): void {
  for (const fn of [...listeners]) {
    fn({ settings: { newValue, oldValue } }, "local");
  }
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
}

function makeEngine(): PageEngine {
  const renderer = new Renderer("bilingual");
  return new PageEngine(renderer, makeSettings());
}

describe("watchMasterSwitchReopen（关闭态 frame 等待重开）", () => {
  it("「开启」事件触发重装配且只触发一次，监听注销自我；「关闭」事件不理会", () => {
    const reopen = vi.fn();
    watchMasterSwitchReopen(reopen);

    fireChange({ enabled: false }, { enabled: true });
    expect(reopen).not.toHaveBeenCalled();

    fireChange({ enabled: true }, { enabled: false });
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(listeners).toHaveLength(0); // 注销自我

    fireChange({ enabled: false }, { enabled: true }); // 注销后的事件不再到达
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it("老版本数据缺失 enabled 字段视为开启", () => {
    const reopen = vi.fn();
    watchMasterSwitchReopen(reopen);
    fireChange({ version: 4 }, undefined); // 无 enabled 的旧 settings 被其它上下文整段重写
    expect(reopen).toHaveBeenCalledTimes(1);
  });
});

describe("installMasterSwitchSync（已装配 frame 的实时同步）", () => {
  function makeHooks(initial = true) {
    const state = { enabled: initial };
    const hooks = {
      getEnabled: () => state.enabled,
      setEnabled: (v: boolean) => {
        state.enabled = v;
      },
      onOff: vi.fn(),
      onOn: vi.fn(),
      state,
    };
    return hooks;
  }

  it("enabled 翻转：运行态镜像更新 + 对应副作用", () => {
    const h = makeHooks(true);
    installMasterSwitchSync(h);
    fireChange({ enabled: false }, { enabled: true });
    expect(h.state.enabled).toBe(false);
    expect(h.onOff).toHaveBeenCalledTimes(1);
    expect(h.onOn).not.toHaveBeenCalled();

    fireChange({ enabled: true }, { enabled: false });
    expect(h.state.enabled).toBe(true);
    expect(h.onOn).toHaveBeenCalledTimes(1);
  });

  it("其它设置项的保存（enabled 不变）不打扰运行态", () => {
    const h = makeHooks(true);
    installMasterSwitchSync(h);
    h.state.enabled = false; // 模拟已被回填/事件置为关闭
    fireChange({ enabled: false, translate: { targetLang: "ja" } }, { enabled: false });
    expect(h.onOff).not.toHaveBeenCalled();
    expect(h.onOn).not.toHaveBeenCalled();
  });

  it("错过事件回填（J-2 竞态）：watch 注销与本监听挂上之间存储已关闭，装配完成后仍落 off", async () => {
    store.settings = { enabled: false }; // 装配窗口内发生且已错过，不会再有事件
    const h = makeHooks(true);
    installMasterSwitchSync(h);
    await flush();
    expect(h.state.enabled).toBe(false);
    expect(h.onOff).toHaveBeenCalledTimes(1);
  });

  it("快照与运行态一致时无副作用", async () => {
    store.settings = { enabled: true };
    const h = makeHooks(true);
    installMasterSwitchSync(h);
    await flush();
    expect(h.onOff).not.toHaveBeenCalled();
    expect(h.onOn).not.toHaveBeenCalled();
  });
});

describe("restoreForSwitchOff（J-1：开关还原 ≠ 用户还原意愿）", () => {
  it("restore() 记录用户还原标记；restoreForSwitchOff() 还原后不遗留标记", () => {
    const engine = makeEngine();
    engine.restore();
    expect(engine.restoredByUser).toBe(true); // 用户点「还原」→ 自动翻译不再译回来

    const engine2 = makeEngine();
    engine2.restoreForSwitchOff();
    expect(engine2.restoredByUser).toBe(false); // 开关关闭 → 重开后补译路径必须仍然放行
    expect(engine2.state).toBe("off");
  });
});

describe("工具条挂载位置（J-3）", () => {
  it("构造后经 placement 挂到 <html> 下，不再随被替换的 body 滚走", () => {
    const engine = makeEngine();
    const toolbar = new Toolbar(engine);
    const el = document.querySelector(".it-toolbar")!;
    expect(el).toBeTruthy();
    expect(el.parentElement).toBe(document.documentElement);
    toolbar.destroy();
    expect(el.isConnected).toBe(false);
  });
});
