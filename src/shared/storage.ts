import type { ApiConfig, Settings } from "./types";

/** 设置结构版本：变更默认值（如自动翻译默认关闭/并发加大）时 +1，老版本读取时迁移 */
const SETTINGS_VERSION = 4;

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  api: {
    format: "openai",
    baseUrl: "",
    apiKey: "",
    model: "",
    temperature: 0.3,
    timeoutMs: 60000,
    // 默认并发保守取 2：叠加后台"请求启动限速"，避免瞬时高并发触发服务商限流/封号。
    // 用户可在设置页按自己服务商的额度上调。
    maxConcurrency: 2,
    // 请求启动限速的间隔（毫秒）：默认 500 ≈ 2 请求/秒，可在设置页按中转站额度调整
    minRequestIntervalMs: 500,
    batchMode: "lines",
    freeEndpoint: "",
    freeBackupEndpoint: "",
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
    viewportLazy: true,
    terminology: [],
    contextEnabled: true,
    contextMaxChars: 3000,
  },
  sites: { whitelist: [], blacklist: [] },
  security: { encryptApiKey: true, sensitivePages: false },
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
  // 按版本逐项迁移，避免覆盖用户在设置页改过的偏好
  if (saved && saved.version !== SETTINGS_VERSION) {
    // v1 → v2：自动翻译默认关闭（老设置里存的 true 归零）
    if (!saved.version || saved.version < 2) {
      merged.translate.autoTranslate = DEFAULT_SETTINGS.translate.autoTranslate;
    }
    // v2 → v3：默认并发改为 2（叠加请求启动限速防服务商限流/封号，E-005）。
    // 注意：无法区分「用户自定义值」与「旧默认值」，该迁移会按新默认值覆盖 v2 设置的并发数。
    if (!saved.version || saved.version < 3) {
      merged.api.maxConcurrency = DEFAULT_SETTINGS.api.maxConcurrency;
    }
    // v3 → v4：取消敏感页不翻译限制（默认关，老设置里存的 true 归零）
    if (!saved.version || saved.version < 4) {
      merged.security.sensitivePages = DEFAULT_SETTINGS.security.sensitivePages;
    }
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

/** 导出磁盘中的原始设置（API Key 保持加密态，避免导出时泄露明文） */
export async function exportSettings(): Promise<Record<string, unknown>> {
  const stored = await chrome.storage.local.get("settings");
  const raw = stored.settings;
  return raw && typeof raw === "object" ? (structuredClone(raw) as Record<string, unknown>) : {};
}

/** 导入设置。兼容直接设置对象以及 { settings: ... } 包装；密钥可为本插件导出的密文或明文。 */
export async function importSettings(input: unknown): Promise<void> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("不是有效的设置文件");
  }
  const wrapper = input as Record<string, unknown>;
  const raw = wrapper.settings ?? input;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("设置内容格式无效");
  }
  const candidate = raw as Partial<Settings>;
  const formats = new Set(["openai", "anthropic", "gemini", "ollama", "googlefree"]);
  if (candidate.api?.format && !formats.has(candidate.api.format)) {
    throw new Error(`不支持的 API 格式：${String(candidate.api.format)}`);
  }
  if (candidate.backupApi?.format && !formats.has(candidate.backupApi.format)) {
    throw new Error(`不支持的备用 API 格式：${String(candidate.backupApi.format)}`);
  }
  await chrome.storage.local.set({ settings: structuredClone(raw) });
  // 立即走一次完整读取/迁移，确保导入内容可用；不会覆盖原始导入数据。
  await getSettings();
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
