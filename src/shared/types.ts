/** API 格式（适配器层支持） */
export type ApiFormat = "openai" | "anthropic" | "gemini" | "ollama";

/** 显示模式：双语对照 / 仅译文 / 原文 */
export type DisplayMode = "bilingual" | "translated" | "original";

/** 扩展设置（chrome.storage.local） */
export interface Settings {
  api: {
    format: ApiFormat;
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    timeoutMs: number;
    maxConcurrency: number;
    backup?: {
      format: ApiFormat;
      baseUrl: string;
      apiKey: string;
      model: string;
    };
  };
  translate: {
    targetLang: string;
    displayMode: DisplayMode;
    autoTranslate: boolean;
    autoDetectSource: boolean;
    minTextLength: number;
    blockMaxChars: number;
    translateOnSelect: boolean;
    translateInput: boolean;
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