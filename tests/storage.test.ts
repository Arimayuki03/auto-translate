import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uninstallChromeMock } from "./helpers/chromeMock";
import {
  DEFAULT_SETTINGS,
  encryptApiKey,
  getSettings,
  importSettings,
  saveSettings,
  updateSettings,
} from "../src/shared/storage";
import type { Settings } from "../src/shared/types";

/** 构造一份已存盘的设置（version + sensitivePages + enabled 可指定） */
function savedSettings(overrides: {
  version?: number;
  sensitivePages?: boolean;
  enabled?: boolean;
}): { settings: Record<string, unknown> } {
  return {
    settings: {
      version: overrides.version ?? 3,
      security: { sensitivePages: overrides.sensitivePages ?? true },
      translate: { autoTranslate: true },
      ...(overrides.enabled !== undefined ? { enabled: overrides.enabled } : {}),
    },
  };
}

let getMock: ReturnType<typeof vi.fn>;
let setMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getMock = vi.fn();
  setMock = vi.fn(async () => {});
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: { get: getMock, set: setMock },
    },
  } as unknown as typeof chrome;
});

afterEach(() => {
  uninstallChromeMock();
  vi.restoreAllMocks();
});

describe("设置迁移 v3 → v4：取消敏感页不翻译限制", () => {
  it("旧设置（version 3）里 sensitivePages=true 会被迁移为 false", async () => {
    getMock.mockResolvedValue(savedSettings({ version: 3, sensitivePages: true }));
    const s = await getSettings();
    expect(s.security.sensitivePages).toBe(false);
    expect(s.version).toBe(5); // 迁移链一路走到当前版本
  });

  it("没有已存设置时默认敏感页保护为关", async () => {
    getMock.mockResolvedValue({});
    const s = await getSettings();
    expect(s.security.sensitivePages).toBe(false);
  });

  it("已是 v4 及以上设置不再触发归零，保留用户自己的选择", async () => {
    // 用户在 v4 里手动打开保护 → 后续版本迁移不应覆盖
    getMock.mockResolvedValue(savedSettings({ version: 4, sensitivePages: true }));
    const s = await getSettings();
    expect(s.security.sensitivePages).toBe(true);
  });
});

describe("设置迁移 v4 → v5：插件总开关", () => {
  it("默认开启", async () => {
    getMock.mockResolvedValue({});
    const s = await getSettings();
    expect(s.enabled).toBe(true);
  });

  it("旧设置（version 4）没有 enabled 字段 → 读取为 true", async () => {
    getMock.mockResolvedValue(savedSettings({ version: 4 }));
    const s = await getSettings();
    expect(s.enabled).toBe(true);
    expect(s.version).toBe(5);
  });

  it("用户显式关闭（version 5）后保持 false", async () => {
    getMock.mockResolvedValue(savedSettings({ version: 5, sensitivePages: false, enabled: false }));
    const s = await getSettings();
    expect(s.enabled).toBe(false);
  });
});

describe("悬停翻译开关（translateHover）", () => {
  it("默认关闭：不出「译」悬停角标", async () => {
    getMock.mockResolvedValue({});
    const s = await getSettings();
    expect(s.translate.translateHover).toBe(false);
  });

  it("用户开启后读取保留 true", async () => {
    getMock.mockResolvedValue({
      settings: { version: 5, translate: { autoTranslate: true, translateHover: true } },
    });
    const s = await getSettings();
    expect(s.translate.translateHover).toBe(true);
  });
});

describe("encryptApiKey=false：明文落盘（security.encryptApiKey 消费回归）", () => {
  /** 构造一份带 API Key 的完整设置 */
  function settingsWithKey(encryptApiKeyFlag: boolean): Settings {
    const base = structuredClone(DEFAULT_SETTINGS);
    base.api.apiKey = "sk-secret-key-123";
    base.security.encryptApiKey = encryptApiKeyFlag;
    return base;
  }

  it("encryptApiKey=false 时 saveSettings 写盘的是明文，不经 encryptApiKey 混淆", async () => {
    await saveSettings(settingsWithKey(false));
    const calls = setMock.mock.calls as Array<[{ settings: Settings }]>;
    const stored = calls[calls.length - 1][0].settings;
    expect(stored.api.apiKey).toBe("sk-secret-key-123"); // 明文，非 at-v2: 混淆值
    expect(stored.api.apiKey).not.toBe(encryptApiKey("sk-secret-key-123"));
  });

  it("encryptApiKey=false 时读回仍得到原明文（decryptApiKey 对明文幂等）", async () => {
    await saveSettings(settingsWithKey(false));
    const calls = setMock.mock.calls as Array<[{ settings: Settings }]>;
    getMock.mockResolvedValue({ settings: structuredClone(calls[calls.length - 1][0].settings) });
    const s = await getSettings();
    expect(s.api.apiKey).toBe("sk-secret-key-123");
  });

  it("encryptApiKey=true（默认）时写盘的仍是混淆值", async () => {
    await saveSettings(settingsWithKey(true));
    const calls = setMock.mock.calls as Array<[{ settings: Settings }]>;
    const stored = calls[calls.length - 1][0].settings;
    expect(stored.api.apiKey).toBe(encryptApiKey("sk-secret-key-123"));
    expect(stored.api.apiKey).not.toBe("sk-secret-key-123");
  });
});

describe("导入 backupApi 的合法形态（C6：空对象/数组不克隆主 API）", () => {
  /** 导入后从 set 落盘值读回设置（importSettings 内部还会再读一次做迁移校验） */
  async function importedSettings(): Promise<Record<string, unknown>> {
    const calls = setMock.mock.calls as Array<[{ settings: Record<string, unknown> }]>;
    return structuredClone(calls[calls.length - 1][0].settings);
  }

  it("导入 backupApi: {} 视为未配置 → 不克隆主 API，免费互切保持可用", async () => {
    getMock.mockResolvedValue({});
    await importSettings({ api: { format: "openai", baseUrl: "https://x" }, backupApi: {} });
    const stored = await importedSettings();
    expect(stored.backupApi).toBeUndefined();
  });

  it("导入 backupApi: [] 同样视为未配置 → 不克隆主 API", async () => {
    getMock.mockResolvedValue({});
    await importSettings({ api: { format: "openai" }, backupApi: [] });
    const stored = await importedSettings();
    expect(stored.backupApi).toBeUndefined();
  });

  it("显式给出部分字段的 backupApi 正常保留（回归保护：部分配置语义不变）", async () => {
    getMock.mockResolvedValue({});
    await importSettings({
      api: { format: "openai" },
      backupApi: { format: "openai", baseUrl: "https://x", model: "m" },
    });
    const stored = await importedSettings();
    expect(stored.backupApi).toMatchObject({ baseUrl: "https://x", model: "m" });
  });
});

describe("updateSettings：读-改-写互斥队列", () => {
  /** 基于内存模型实现 chrome.storage mock：get 读当前值，set 原地写——
   *  与真实 chrome.storage.local 一致（写后读可见），这是复现「读陈旧快照回滚并发写」的前提 */
  let memory: { settings?: Record<string, unknown> };

  beforeEach(() => {
    memory = {
      settings: structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>,
    };
    getMock.mockImplementation(async (key: string) =>
      // 注意 getSettings 读取的是 { settings: ... } 包装结构
      key === "settings" ? { settings: structuredClone(memory.settings ?? {}) } : {}
    );
    setMock.mockImplementation(async (items: Record<string, unknown>) => {
      if ("settings" in items) {
        memory.settings = structuredClone(items.settings) as Record<string, unknown>;
      }
    });
  });

  /** 从最后一次落盘值读回设置 */
  function lastStored(): Settings {
    const calls = setMock.mock.calls as Array<[{ settings: Settings }]>;
    return structuredClone(calls[calls.length - 1][0].settings);
  }

  it("两个并发 updateSettings 交错：后写者基于先写者落盘后的最新值，两次修改都保留", async () => {
    // 复现确定性交错：第一个 mutator 在内挂起期间，第二个 updateSettings 已排队。
    // 旧实现（各自 get → 改 → save）会让 B 读到 A 落盘前的旧快照：A 最终整体落盘时
    // 会把 B 的 enabled=false 回滚掉。队列实现保证 B 的读取发生在 A 落盘之后。
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let bSawWhitelist: readonly string[] = [];

    const p1 = updateSettings((s) => {
      s.sites.whitelist.push("popup.example.com");
      // 挂起 A：此刻 B 必须排队等待，而不是与 A 交错读旧快照（真实场景：popup 写盘期间设置页保存）
      return firstGate;
    });
    const p2 = updateSettings((s) => {
      bSawWhitelist = [...s.sites.whitelist];
      s.enabled = false;
    });

    // 让微任务跑一圈：A 应停在门上、B 排在队尾，两者都尚未落盘
    await new Promise((r) => setTimeout(r, 0));
    expect(setMock).not.toHaveBeenCalled(); // 串行队列：A 未完成前 B 不开工

    releaseFirst();
    await Promise.all([p1, p2]);

    // 后写者 B 读到的是 A 落盘后的最新值（旧实现这里读不到 popup 刚加的条目）
    expect(bSawWhitelist).toContain("popup.example.com");
    const stored = lastStored();
    expect(stored.sites.whitelist).toContain("popup.example.com"); // A 的修改不被 B 覆盖
    expect(stored.enabled).toBe(false); // B 的修改不被 A 的整体落盘回滚
  });

  it("mutator 抛错时该次修改不落盘，队列继续运转（后续调用正常执行）", async () => {
    const p1 = updateSettings(() => {
      throw new Error("boom");
    });
    await expect(p1).rejects.toThrow("boom");
    const s = await updateSettings((draft) => {
      draft.translate.autoTranslate = true;
    });
    expect(s.translate.autoTranslate).toBe(true);
    expect(lastStored().translate.autoTranslate).toBe(true);
  });

  it("mutator 收到深拷贝：就地修改不污染 DEFAULT_SETTINGS 与后续读取", async () => {
    await updateSettings((s) => {
      s.sites.whitelist.push("pollute.example.com");
    });
    // DEFAULT_SETTINGS 未被引用污染（P1-21 回归口径）
    expect(DEFAULT_SETTINGS.sites.whitelist).toEqual([]);
    const fresh = await getSettings();
    expect(fresh.sites.whitelist).toEqual(["pollute.example.com"]);
  });

  it("返回值为最终落盘的设置（调用方可直接更新 UI）", async () => {
    getMock.mockResolvedValue({}); // 走默认值底座
    const s = await updateSettings((draft) => {
      draft.enabled = false;
    });
    expect(s.enabled).toBe(false);
    expect(lastStored().enabled).toBe(false);
  });
});
