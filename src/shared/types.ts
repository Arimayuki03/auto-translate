/** API 格式（适配器层支持） */
export type ApiFormat = "openai" | "anthropic" | "gemini" | "ollama";

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