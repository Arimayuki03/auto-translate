import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSettings, importSettings } from "../src/shared/storage";

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
