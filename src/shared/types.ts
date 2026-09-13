/** API 格式（适配器层支持）；googlefree 为免 key 的 Google 免费通道 */
export type ApiFormat = "openai" | "anthropic" | "gemini" | "ollama" | "googlefree";

/** 批量翻译协议：旧版逐行协议默认兼容性最好；哨兵协议适合明确支持严格分隔输出的模型 */
export type BatchMode = "lines" | "separator";

/** 显示模式：双语对照 / 仅译文 / 原文 */
export type DisplayMode = "bilingual" | "translated" | "original";

/** API 连接配置（主 / 备用共用） */
export interface ApiConfig {
  format: ApiFormat;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  maxConcurrency: number;
  /** 第三方 LLM 默认使用旧版逐行协议；Google 免费通道内部固定使用安全哨兵协议 */
  batchMode?: BatchMode;
  /** Google 免费通道可选主/备用端点；留空使用内置公开端点 */
  freeEndpoint?: string;
  freeBackupEndpoint?: string;
}

/** 扩展设置（chrome.storage.local，apiKey 落盘前加密） */
export interface Settings {
  /** 设置结构版本（用于迁移默认值变更） */
  version?: number;
  api: ApiConfig;
  backupApi?: ApiConfig;
  translate: {
    targetLang: string;
    displayMode: DisplayMode;
    autoTranslate: boolean;
    autoDetectSource: boolean;
    minTextLength: number;
    blockMaxChars: number;
    translateOnSelect: boolean;
    translateInput: boolean;
    viewportLazy: boolean;
    terminology: string[];
    /** 页面上下文仅用于整页翻译；划词/输入框翻译不会携带 */
    contextEnabled?: boolean;
    /** 标题、描述、正文摘要合计最大字符数 */
    contextMaxChars?: number;
  };
  sites: {
    whitelist: string[];
    blacklist: string[];
  };
  security: {
    encryptApiKey: boolean;
    sensitivePages: boolean;
  };
  cache: {
    enabled: boolean;
    maxEntries: number;
  };
}
