/**
 * 设置兼容性回归测试：
 * - 默认 API 保持 OpenAI 兼容通道，不强制改成 Google 免费通道；
 * - 已有 version:4 设置的第三方 API 配置（BaseURL/Key/模型/温度/超时/并发/批量协议）读取后完全保留；
 * - 导出/导入往返后 API Key、BaseURL、模型、provider 正确恢复；
 * - 导入校验：provider 格式非法时拒绝。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decryptApiKey,
  encryptApiKey,
  exportSettings,
  getSettings,
  importSettings,
} from "../src/shared/storage";
import type { Settings } from "../src/shared/types";

function fullSettings(overrides?: Partial<Settings>): Settings {
  return {
    version: 4,
    api: {
      format: "openai",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-original-key",
      model: "deepseek-chat",
      temperature: 0.2,
      timeoutMs: 120000,
      maxConcurrency: 6,
      batchMode: "lines",
      customSystemPrompt: "保持术语一致。",
      freeEndpoint: "https://translate.example/free",
      freeBackupEndpoint: "https://translate.example/backup",
    },
    backupApi: {
      format: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "sk-backup-key",
      model: "gemini-2.0-flash",
      temperature: 0.2,
      timeoutMs: 120000,
      maxConcurrency: 6,
    },
    translate: {
      targetLang: "ja",
      displayMode: "translated",
      autoTranslate: true,
      autoDetectSource: false,
      minTextLength: 6,
      blockMaxChars: 1500,
      translateOnSelect: false,
      translateInput: false,
      viewportLazy: true,
      terminology: ["Claude", "Gemini"],
      contextEnabled: false,
      contextMaxChars: 5000,
    },
    sites: { whitelist: ["docs.example.com"], blacklist: ["login.example.com"] },
    security: { encryptApiKey: true, sensitivePages: true },
    cache: { enabled: false, maxEntries: 200 },
    ...overrides,
  };
}

/** 内存版 chrome.storage，支持 get/set/remove */
function mockStorage(initial: Record<string, unknown> = {}): Map<string, unknown> {
  const memory = new Map(Object.entries(initial));
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of list) if (memory.has(k)) out[k] = memory.get(k);
          return out;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) memory.set(k, v);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) memory.delete(k);
        }),
      },
    },
  } as unknown as typeof chrome;
  return memory;
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("默认 API 不被强制改为 Google 免费通道", () => {
  it("未保存设置时默认 format 为 openai（保持历史默认）", async () => {
    mockStorage();
    const s = await getSettings();
    expect(s.api.format).toBe("openai");
    expect(s.api.batchMode).toBe("lines");
  });

  it("没有自动注入 googlefree 备份通道", async () => {
    mockStorage();
    const s = await getSettings();
    expect(s.backupApi).toBeUndefined();
  });
});

describe("v4 设置的第三方 API 配置完全保留", () => {
  it("读取后 format/baseUrl/apiKey/model/温度/超时/并发/批量协议原样保留", async () => {
    mockStorage({ settings: structuredClone(fullSettings()) });
    const s = await getSettings();
    expect(s.api).toMatchObject({
      format: "openai",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-original-key", // 解密后的明文
      model: "deepseek-chat",
      temperature: 0.2,
      timeoutMs: 120000,
      maxConcurrency: 6,
      batchMode: "lines",
      customSystemPrompt: "保持术语一致。",
      freeEndpoint: "https://translate.example/free",
      freeBackupEndpoint: "https://translate.example/backup",
    });
    expect(s.backupApi).toMatchObject({
      format: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "sk-backup-key",
      model: "gemini-2.0-flash",
    });
    // 非默认偏好原样保留
    expect(s.translate).toMatchObject({
      targetLang: "ja",
      displayMode: "translated",
      autoTranslate: true,
      autoDetectSource: false,
      contextEnabled: false,
      contextMaxChars: 5000,
    });
    expect(s.sites.whitelist).toEqual(["docs.example.com"]);
    expect(s.sites.blacklist).toEqual(["login.example.com"]);
    expect(s.cache.enabled).toBe(false);
    expect(s.security.sensitivePages).toBe(true);
  });

  it("没有强制把 version:4 的已有设置覆盖回默认值", async () => {
    mockStorage({ settings: structuredClone(fullSettings()) });
    const s = await getSettings();
    // version 4 与当前版本一致 → 不做迁移，字段逐项保留
    expect(s.version).toBe(4);
    expect(s.api.maxConcurrency).toBe(6); // 默认是 3，用户设了 6 → 保留
    expect(s.translate.autoDetectSource).toBe(false); // 默认是 true → 保留
  });
});

describe("加密往返", () => {
  it("encrypt → decrypt 恢复原文", () => {
    const enc = encryptApiKey("sk-secret-value");
    expect(enc).not.toContain("sk-secret-value");
    expect(decryptApiKey(enc)).toBe("sk-secret-value");
  });

  it("空 Key 加密/解密为空串", () => {
    expect(encryptApiKey("")).toBe("");
    expect(decryptApiKey("")).toBe("");
  });
});

describe("导出 / 导入往返", () => {
  it("导出含加密 Key，导入后 getSettings 恢复明文配置", async () => {
    const memory = mockStorage({ settings: structuredClone(fullSettings()) });
    // 落盘时 Key 应为密文（saveSettings 的职责，这里模拟已加密的存储）
    const raw = memory.get("settings") as Settings;
    raw.api.apiKey = encryptApiKey("sk-original-key");
    if (raw.backupApi) raw.backupApi.apiKey = encryptApiKey("sk-backup-key");

    const exported = await exportSettings();
    // 导出的是磁盘原始数据：Key 为密文，不泄露明文
    const expRaw = (exported as { settings?: Settings }).settings ?? exported;
    expect(expRaw).toBeDefined();
    expect(JSON.stringify(exported)).not.toContain("sk-original-key");
    expect(JSON.stringify(exported)).not.toContain("sk-backup-key");

    // 清空存储后导入导出文件 → getSettings 恢复完整配置
    memory.clear();
    await importSettings(exported);
    const s = await getSettings();
    expect(s.api.format).toBe("openai");
    expect(s.api.baseUrl).toBe("https://api.example.com/v1");
    expect(s.api.apiKey).toBe("sk-original-key");
    expect(s.api.model).toBe("deepseek-chat");
    expect(s.backupApi?.format).toBe("gemini");
    expect(s.backupApi?.apiKey).toBe("sk-backup-key");
    expect(s.translate.targetLang).toBe("ja");
  });

  it("导入兼容 { settings: ... } 包装与明文 Key", async () => {
    mockStorage();
    const wrapper = { settings: structuredClone(fullSettings()) }; // 明文 Key + 包装
    await importSettings(wrapper);
    const s = await getSettings();
    expect(s.api.apiKey).toBe("sk-original-key");
    expect(s.api.format).toBe("openai");
  });

  it("导入拒绝非法 provider 格式", async () => {
    mockStorage();
    const bad = { settings: structuredClone(fullSettings({ api: { ...fullSettings().api, format: "hack" as never } })) };
    await expect(importSettings(bad)).rejects.toThrow("不支持的 API 格式");
  });

  it("导入拒绝非对象/数组输入", async () => {
    mockStorage();
    await expect(importSettings(null)).rejects.toThrow("不是有效的设置文件");
    await expect(importSettings([1, 2])).rejects.toThrow("不是有效的设置文件");
  });
});

describe("自定义翻译 prompt（api.customSystemPrompt）兼容性", () => {
  it("旧版 v4 设置没有该字段 → 读取为默认空串（不触发版本迁移）", async () => {
    const saved = fullSettings();
    delete (saved.api as { customSystemPrompt?: string }).customSystemPrompt;
    mockStorage({ settings: structuredClone(saved) });
    const s = await getSettings();
    expect(s.api.customSystemPrompt).toBe("");
    expect(s.version).toBe(4);
  });

  it("用户已配置的附加指令读取时原样保留", async () => {
    mockStorage({ settings: structuredClone(fullSettings()) });
    const s = await getSettings();
    expect(s.api.customSystemPrompt).toBe("保持术语一致。");
  });

  it("导出/导入往返后附加指令不丢失", async () => {
    const memory = mockStorage({ settings: structuredClone(fullSettings()) });
    const exported = await exportSettings();
    memory.clear();
    await importSettings(exported);
    const s = await getSettings();
    expect(s.api.customSystemPrompt).toBe("保持术语一致。");
  });
});
