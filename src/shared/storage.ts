import type { ApiConfig, Settings } from "./types";

/** 设置结构版本：变更默认值（如自动翻译默认关闭）时 +1，老版本读取时迁移 */
const SETTINGS_VERSION = 2;

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  api: {
    format: "openai",
    baseUrl: "",
    apiKey: "",
    model: "",
    temperature: 0.3,
    timeoutMs: 60000,
    maxConcurrency: 3,
  },
  translate: {
    targetLang: "zh-CN",
    displayMode: "bilingual",
    autoTranslate: false,
    autoDetectSource: true,
    minTextLength: 4,
    blockMaxChars: 1200,
    translateOnSelect: true,
    translateInput: true,
    terminology: [],
  },
  sites: { whitelist: [], blacklist: [] },
  security: { encryptApiKey: true, sensitivePages: true },
  cache: { enabled: true, maxEntries: 5000 },
};

const KEY_SALT = "at-v1:";

/** 轻量混淆（真实隔离依赖 chrome.storage 与用户自行保管 Key） */
export function encryptApiKey(plain: string): string {
  if (!plain) return "";
  try {
    return btoa(xor(KEY_SALT + plain));
  } catch {
    return plain;
  }
}

export function decryptApiKey(encoded: string): string {
  if (!encoded) return "";
  try {
    const raw = xor(atob(encoded));
    return raw.startsWith(KEY_SALT) ? raw.slice(KEY_SALT.length) : raw;
  } catch {
    return encoded;
  }
}

function xor(text: string): string {
  return Array.from(text)
    .map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ (0x5a ^ (i & 0xff))))
    .join("");
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get("settings");
  const saved = stored.settings as Partial<Settings> | undefined;
  const merged = mergeSettings(DEFAULT_SETTINGS, saved ?? {});
  // v1 → v2：自动翻译默认关闭，老设置里存的 true 归零（下次保存时落盘）
  if (saved && saved.version !== SETTINGS_VERSION) {
    merged.translate.autoTranslate = DEFAULT_SETTINGS.translate.autoTranslate;
    merged.version = SETTINGS_VERSION;
  }
  merged.api.apiKey = decryptApiKey(merged.api.apiKey);
  if (merged.backupApi) {
    merged.backupApi.apiKey = decryptApiKey(merged.backupApi.apiKey);
  }
  return merged;
}

export async function saveSettings(settings: Settings): Promise<void> {
  const toStore: Settings = structuredClone(settings);
  toStore.api.apiKey = encryptApiKey(toStore.api.apiKey);
  if (toStore.backupApi) {
    toStore.backupApi.apiKey = encryptApiKey(toStore.backupApi.apiKey);
  }
  await chrome.storage.local.set({ settings: toStore });
}

function mergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  const api: ApiConfig = { ...base.api, ...(patch.api ?? {}) };
  return {
    ...base,
    ...patch,
    api,
    backupApi: patch.backupApi ? { ...api, ...patch.backupApi } : undefined,
    translate: { ...base.translate, ...(patch.translate ?? {}) },
    sites: { ...base.sites, ...(patch.sites ?? {}) },
    security: { ...base.security, ...(patch.security ?? {}) },
    cache: { ...base.cache, ...(patch.cache ?? {}) },
  };
}