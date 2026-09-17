import type { ApiConfig, Settings } from "./types";
import { sanitizeSiteRules } from "./siteRules";

/** 设置结构版本：变更默认值（如自动翻译默认关闭/并发加大）时 +1，老版本读取时迁移 */
const SETTINGS_VERSION = 5;

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  enabled: true,
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
    translateHover: false,
    viewportLazy: true,
    terminology: [],
    contextEnabled: true,
    contextMaxChars: 3000,
    summaryEnabled: false,
    summaryMinChars: 6000,
    style: "gray",
    customCss: "",
    translateAttributes: true,
    forceSourceLang: "",
  },
  sites: { whitelist: [], blacklist: [], rules: [], disabledRuleIds: [] },
  tts: { enabled: true, voice: "", rate: 0 },
  security: { encryptApiKey: true, sensitivePages: false },
  cache: { enabled: true, maxEntries: 5000, ttlDays: 7 },
};

const KEY_SALT = "at-v1:";
/** v2：载荷先按 UTF-8 编码再做字节级 XOR，因此对任意 Unicode Key 都能编码。
 *  v1 是「UTF-16 码元 XOR 后 btoa」，含非 Latin-1 字符时 btoa 抛错 → catch 返回
 *  明文原文，等于把用户的 Key 直接写盘。读取路径仍兼容 v1，下次保存自动升级为 v2。 */
const KEY_PREFIX = "at-v2:";

/**
 * Key 的落盘混淆（**不是加密**：固定常量密钥流、无秘密输入，能还原）。
 * 这里保证的是两条工程不变量：
 *  1) 磁盘上永远不出现明文 Key（任何字符集都成立）；
 *  2) 真实隔离依赖 chrome.storage 的作用域与用户自行保管。
 * 需要真加密时须引入不可导出的密钥（crypto.subtle + storage.session），不要指望本函数。
 */
export function encryptApiKey(plain: string): string {
  if (!plain) return "";
  return base64FromBytes(xorBytes(new TextEncoder().encode(KEY_PREFIX + plain)));
}

/** 解码落盘值：v2 → v1 → 原样返回（视为历史明文 / 用户手填明文） */
export function decryptApiKey(encoded: string): string {
  if (!encoded) return "";
  const bytes = bytesFromBase64(encoded);
  if (!bytes) return encoded;
  const v2 = decodeUtf8(xorBytes(bytes));
  if (v2.startsWith(KEY_PREFIX)) return v2.slice(KEY_PREFIX.length);
  const v1 = legacyXorString(binaryFromBytes(bytes));
  if (v1.startsWith(KEY_SALT)) return v1.slice(KEY_SALT.length);
  return encoded;
}

function keystreamByte(i: number): number {
  return 0x5a ^ (i & 0xff);
}

function xorBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ keystreamByte(i);
  return out;
}

/** v1 历史格式：在 UTF-16 码元上做同样的位置相关 XOR（仅用于读老数据） */
function legacyXorString(text: string): string {
  return Array.from(text)
    .map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ keystreamByte(i)))
    .join("");
}

function base64FromBytes(bytes: Uint8Array): string {
  return btoa(binaryFromBytes(bytes));
}

function binaryFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return binary;
}

/** 非 Base64（含 v1 里 btoa 失败留下的明文 Key）返回 null，调用方按明文处理 */
function bytesFromBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
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
    // v4 → v5：插件总开关默认开启（老设置没有该字段时补默认值 true）
    if (!saved.version || saved.version < 5) {
      merged.enabled = DEFAULT_SETTINGS.enabled;
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

const SUPPORTED_FORMATS = [
  "openai",
  "anthropic",
  "gemini",
  "ollama",
  "googlefree",
  "microsoft",
] as const;

/** 数值设置项的合法区间：导入校验与设置页保存钳制共用这一份，与 options.html
 *  输入框的 min/max 属性保持一致。改区间只动这里，别在两处各写一套数字。 */
export const SETTING_RANGES = {
  temperature: [0, 2],
  /** 设置页以「秒」输入超时（落盘为毫秒），单独存秒区间 */
  timeoutSeconds: [5, 300],
  timeoutMs: [5000, 300_000],
  maxConcurrency: [1, 10],
  minRequestIntervalMs: [50, 10_000],
  minTextLength: [0, 200],
  blockMaxChars: [100, 5000],
  contextMaxChars: [0, 20_000],
  summaryMinChars: [0, 100_000],
  ttsRate: [-50, 100],
  cacheMaxEntries: [1, 100_000],
  cacheTtlDays: [0, 365],
} as const;

/** 导入文件的逐字段校验：只产出「文件里出现且类型合法」的字段补丁（unknown 字段与
 *  类型错乱字段剔除），由 importSettings 以当前设置为底合并落盘。
 *  此前只校验 api.format：手工编辑的文件若把 sites.blacklist 写成字符串等，
 *  落盘后 content 侧 shouldTranslatePage 调 .some 会抛错，导致所有页面注入失败。 */
function buildImportPatch(raw: unknown): SettingsPatch {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  /** 带区间的数值校验：越界一律当作「字段未提供」丢弃（回退当前值/默认值）。
   *  blockMaxChars / minTextLength / cache.maxEntries 在设置页**没有输入控件**，
   *  导入文件是它们的唯一入口——此前无范围校验，写 blockMaxChars: 0 会让
   *  extractor 的 `i += maxChars` 永不推进，整页提取时主线程无限卡死。 */
  const numOf =
    (min: number, max: number) =>
    (v: unknown): number | undefined => {
      const n = num(v);
      return n === undefined || n < min || n > max ? undefined : n;
    };
  const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
  const strArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined;
  const enumOf =
    <T extends string>(allowed: readonly T[]) =>
    (v: unknown): T | undefined =>
      allowed.includes(v as T) ? (v as T) : undefined;
  /** 按 spec 挑选对象里的已知字段（类型不符的丢弃） */
  const pick = (
    value: unknown,
    spec: Record<string, (v: unknown) => unknown>
  ): Record<string, unknown> => {
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
    temperature: numOf(...SETTING_RANGES.temperature),
    timeoutMs: numOf(...SETTING_RANGES.timeoutMs),
    maxConcurrency: numOf(...SETTING_RANGES.maxConcurrency),
    minRequestIntervalMs: numOf(...SETTING_RANGES.minRequestIntervalMs),
    batchMode: enumOf(["lines", "separator"] as const),
    customSystemPrompt: str,
    freeEndpoint: str,
    freeBackupEndpoint: str,
  };
  const patch: SettingsPatch = {
    enabled: bool(r.enabled),
    api: pick(r.api, apiSpec) as unknown as Partial<ApiConfig>,
    translate: pick(r.translate, {
      targetLang: str,
      displayMode: enumOf(["bilingual", "translated", "original"] as const),
      autoTranslate: bool,
      autoDetectSource: bool,
      minTextLength: numOf(...SETTING_RANGES.minTextLength),
      blockMaxChars: numOf(...SETTING_RANGES.blockMaxChars),
      translateOnSelect: bool,
      translateInput: bool,
      translateHover: bool,
      viewportLazy: bool,
      terminology: strArr,
      contextEnabled: bool,
      contextMaxChars: numOf(...SETTING_RANGES.contextMaxChars),
      summaryEnabled: bool,
      summaryMinChars: numOf(...SETTING_RANGES.summaryMinChars),
      style: enumOf(["gray", "outline", "underline", "blur"] as const),
      customCss: str,
      translateAttributes: bool,
      forceSourceLang: str,
    }) as unknown as Partial<Settings["translate"]>,
    sites: pick(r.sites, {
      whitelist: strArr,
      blacklist: strArr,
      rules: sanitizeSiteRules,
      disabledRuleIds: strArr,
    }) as unknown as Partial<Settings["sites"]>,
    tts: pick(r.tts, {
      enabled: bool,
      voice: str,
      rate: numOf(...SETTING_RANGES.ttsRate),
    }) as unknown as Partial<Settings["tts"]>,
    security: pick(r.security, {
      encryptApiKey: bool,
      sensitivePages: bool,
    }) as unknown as Partial<Settings["security"]>,
    cache: pick(r.cache, {
      enabled: bool,
      maxEntries: numOf(...SETTING_RANGES.cacheMaxEntries),
      ttlDays: numOf(...SETTING_RANGES.cacheTtlDays),
    }) as unknown as Partial<Settings["cache"]>,
  };
  // 备用 API 显式给出对象时才存在（沿用主备字段继承语义：缺的字段拿主 API 补）
  if (r.backupApi && typeof r.backupApi === "object") {
    patch.backupApi = {
      ...patch.api,
      ...pick(r.backupApi, apiSpec),
    } as unknown as Partial<ApiConfig>;
  }
  return patch;
}

/** 文件里至少要出现一个已知设置段，才认作设置文件——否则「误选 package.json」
 *  这类对象会被当成全空补丁静默导入（P0-4 的第一道防线） */
const KNOWN_IMPORT_SECTIONS = [
  "enabled",
  "api",
  "translate",
  "sites",
  "tts",
  "security",
  "cache",
  "backupApi",
] as const;

/** 导入文件里的 Key 可能是本插件导出的混淆值（v1/v2），也可能是用户手填的明文。
 *  只有解出内容带自家前缀才算导出值；其余一律视为明文——包括恰好是合法 Base64
 *  的明文 Key（此前落盘不混淆，读取路径无条件解码会把它们解成乱码，P0-4 第二道防线）。 */
function normalizeImportedKey(value: string): string {
  if (!value) return value;
  const decoded = decryptApiKey(value);
  return decoded === value ? value : decoded;
}

/** 导入设置。兼容直接设置对象以及 { settings: ... } 包装；密钥可为本插件导出的密文或明文。
 *  以「当前设置」为底合并文件中的合法字段后落盘：文件没写的字段保持原值，
 *  不再被静默重置为默认值（P0-4）。Key 统一归一为明文，经 saveSettings 加密落盘，
 *  维持「磁盘上永远是密文」的读取不变量。 */
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
  const rawObj = raw as Record<string, unknown>;
  if (!KNOWN_IMPORT_SECTIONS.some((section) => section in rawObj)) {
    throw new Error("不是有效的设置文件：未找到任何可识别的设置段");
  }
  const patch = buildImportPatch(rawObj);
  if (patch.api?.apiKey) patch.api.apiKey = normalizeImportedKey(patch.api.apiKey);
  if (patch.backupApi?.apiKey) {
    patch.backupApi.apiKey = normalizeImportedKey(patch.backupApi.apiKey);
  }
  const current = await getSettings(); // 明文完整设置（含既有迁移）
  const merged = mergeSettings(current, patch);
  merged.version = SETTINGS_VERSION;
  await saveSettings(merged); // Key 经 encryptApiKey 落盘，读取路径的解密恒成立
  // 立即走一次完整读取/迁移，确保导入内容可用；不会覆盖原始导入数据。
  await getSettings();
}

/** 设置补丁类型：各段均可只给部分字段（getSettings 的存储读取 / importSettings 的
 *  导入校验共用），mergeSettings 负责把缺失字段补齐为默认值 */
type SettingsPatch = {
  version?: number;
  enabled?: boolean;
  api?: Partial<ApiConfig>;
  backupApi?: Partial<ApiConfig>;
  translate?: Partial<Settings["translate"]>;
  sites?: Partial<Settings["sites"]>;
  tts?: Partial<Settings["tts"]>;
  security?: Partial<Settings["security"]>;
  cache?: Partial<Settings["cache"]>;
};

function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  // 深拷贝 base 再合并：返回值不得外带 DEFAULT_SETTINGS（或存储对象）的引用——
  // 调用方会在 getSettings() 结果上就地 push/splice 数组（popup 加白名单），
  // 共享引用会污染全局默认值（P1-21）
  const b = structuredClone(base);
  const api: ApiConfig = { ...b.api, ...(patch.api ?? {}) };
  const enabled: boolean = patch.enabled ?? b.enabled;
  return {
    ...b,
    ...patch,
    api,
    // 文件/存储没提 backupApi 时保留 base 的既有备用通道（导入语义：只更新出现的字段）
    backupApi: patch.backupApi ? { ...api, ...patch.backupApi } : b.backupApi,
    translate: { ...b.translate, ...(patch.translate ?? {}) },
    sites: { ...b.sites, ...(patch.sites ?? {}) },
    tts: { ...b.tts, ...(patch.tts ?? {}) },
    security: { ...b.security, ...(patch.security ?? {}) },
    cache: { ...b.cache, ...(patch.cache ?? {}) },
    enabled,
  };
}
