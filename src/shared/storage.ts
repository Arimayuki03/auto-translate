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
    customSystemPrompt: "",
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
    style: "gray",
    customCss: "",
    translateAttributes: true,
  },
  sites: { whitelist: [], blacklist: [] },
  tts: { enabled: true, voice: "", rate: 0 },
  security: { encryptApiKey: true, sensitivePages: false },
  cache: { enabled: true, maxEntries: 5000, ttlDays: 7 },
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

const SUPPORTED_FORMATS = ["openai", "anthropic", "gemini", "ollama", "googlefree", "microsoft"] as const;

/** 导入设置的逐字段校验：只接受已知字段与正确类型，非法字段剔除（回退默认值）。
 *  此前只校验 api.format：手工编辑的导入文件若把 sites.blacklist 写成字符串等，
 *  落盘后 content 侧 shouldTranslatePage 调 .some 会抛错，导致所有页面注入失败。 */
function sanitizeImportSettings(raw: unknown): Settings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
  const strArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined;
  const enumOf =
    <T extends string>(allowed: readonly T[]) =>
    (v: unknown): T | undefined =>
      allowed.includes(v as T) ? (v as T) : undefined;
  /** 按 spec 挑选对象里的已知字段（类型不符的丢弃） */
  const pick = (value: unknown, spec: Record<string, (v: unknown) => unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (!value || typeof value !== "object") return out;
    const obj = value as Record<string, unknown>;
    for (const [k, coerce] of Object.entries(spec)) {
      const v = coerce(obj[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  };

  const apiSpec = {
    format: enumOf(SUPPORTED_FORMATS),
    baseUrl: str,
    apiKey: str,
    model: str,
    temperature: num,
    timeoutMs: num,
    maxConcurrency: num,
    minRequestIntervalMs: num,
    batchMode: enumOf(["lines", "separator"] as const),
    customSystemPrompt: str,
    freeEndpoint: str,
    freeBackupEndpoint: str,
  };
  const patch: SettingsPatch = {
    api: pick(r.api, apiSpec) as unknown as Partial<ApiConfig>,
    translate: pick(r.translate, {
      targetLang: str,
      displayMode: enumOf(["bilingual", "translated", "original"] as const),
      autoTranslate: bool,
      autoDetectSource: bool,
      minTextLength: num,
      blockMaxChars: num,
      translateOnSelect: bool,
      translateInput: bool,
      viewportLazy: bool,
      terminology: strArr,
      contextEnabled: bool,
      contextMaxChars: num,
      style: enumOf(["gray", "outline", "underline", "blur"] as const),
      customCss: str,
      translateAttributes: bool,
    }) as unknown as Partial<Settings["translate"]>,
    sites: pick(r.sites, {
      whitelist: strArr,
      blacklist: strArr,
    }) as unknown as Partial<Settings["sites"]>,
    tts: pick(r.tts, {
      enabled: bool,
      voice: str,
      rate: num,
    }) as unknown as Partial<Settings["tts"]>,
    security: pick(r.security, {
      encryptApiKey: bool,
      sensitivePages: bool,
    }) as unknown as Partial<Settings["security"]>,
    cache: pick(r.cache, {
      enabled: bool,
      maxEntries: num,
      ttlDays: num,
    }) as unknown as Partial<Settings["cache"]>,
  };
  // 备用 API 显式给出对象时才存在（沿用主备字段继承语义：缺的字段拿主 API 补）
  if (r.backupApi && typeof r.backupApi === "object") {
    patch.backupApi = { ...patch.api, ...pick(r.backupApi, apiSpec) } as unknown as Partial<ApiConfig>;
  }
  const merged = mergeSettings(DEFAULT_SETTINGS, patch);
  merged.version = SETTINGS_VERSION;
  return merged;
}

/** 导入设置。兼容直接设置对象以及 { settings: ... } 包装；密钥可为本插件导出的密文或明文。
 *  内容经逐字段校验后合并出完整设置落盘：缺失段回退默认值，类型错乱字段被剔除。 */
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
  const formats = new Set<string>(SUPPORTED_FORMATS);
  if (candidate.api?.format && !formats.has(candidate.api.format)) {
    throw new Error(`不支持的 API 格式：${String(candidate.api.format)}`);
  }
  if (candidate.backupApi?.format && !formats.has(candidate.backupApi.format)) {
    throw new Error(`不支持的备用 API 格式：${String(candidate.backupApi.format)}`);
  }
  const merged = sanitizeImportSettings(raw);
  await chrome.storage.local.set({ settings: structuredClone(merged) });
  // 立即走一次完整读取/迁移，确保导入内容可用；不会覆盖原始导入数据。
  await getSettings();
}

/** 设置补丁类型：各段均可只给部分字段（getSettings 的存储读取 / importSettings 的
 *  导入校验共用），mergeSettings 负责把缺失字段补齐为默认值 */
type SettingsPatch = {
  version?: number;
  api?: Partial<ApiConfig>;
  backupApi?: Partial<ApiConfig>;
  translate?: Partial<Settings["translate"]>;
  sites?: Partial<Settings["sites"]>;
  tts?: Partial<Settings["tts"]>;
  security?: Partial<Settings["security"]>;
  cache?: Partial<Settings["cache"]>;
};

function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  const api: ApiConfig = { ...base.api, ...(patch.api ?? {}) };
  return {
    ...base,
    ...patch,
    api,
    backupApi: patch.backupApi ? { ...api, ...patch.backupApi } : undefined,
    translate: { ...base.translate, ...(patch.translate ?? {}) },
    sites: { ...base.sites, ...(patch.sites ?? {}) },
    tts: { ...base.tts, ...(patch.tts ?? {}) },
    security: { ...base.security, ...(patch.security ?? {}) },
    cache: { ...base.cache, ...(patch.cache ?? {}) },
  };
}
