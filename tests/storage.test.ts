import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSettings } from "../src/shared/storage";

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

beforeEach(() => {
  getMock = vi.fn();
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: { get: getMock },
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
