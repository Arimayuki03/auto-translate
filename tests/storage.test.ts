import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSettings } from "../src/shared/storage";

/** 构造一份已存盘的设置（version + sensitivePages 可指定） */
function savedSettings(overrides: {
  version?: number;
  sensitivePages?: boolean;
}): { settings: Record<string, unknown> } {
  return {
    settings: {
      version: overrides.version ?? 3,
      security: { sensitivePages: overrides.sensitivePages ?? true },
      translate: { autoTranslate: true },
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
    expect(s.version).toBe(4);
  });

  it("没有已存设置时默认敏感页保护为关", async () => {
    getMock.mockResolvedValue({});
    const s = await getSettings();
    expect(s.security.sensitivePages).toBe(false);
  });

  it("已是新版本（version 4）时保留用户自己的选择", async () => {
    // 用户在新版本里手动打开保护 → 不应被迁移覆盖
    getMock.mockResolvedValue(savedSettings({ version: 4, sensitivePages: true }));
    const s = await getSettings();
    expect(s.security.sensitivePages).toBe(true);
  });
});
