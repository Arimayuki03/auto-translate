import type { ApiConfig, ApiFormat } from "./types";

export type ApiErrorCode =
  | "auth"
  | "not_found"
  | "rate_limit"
  | "server"
  | "bad_request"
  | "bad_response"
  | "timeout"
  | "network";

/** 可复制的脱敏诊断信息：endpoint 永远不含查询参数，responsePreview 会替换已知密钥 */
export interface ApiDiagnostic {
  provider: ApiFormat;
  endpoint: string;
  hostname: string;
  source?: "main" | "backup";
  status?: number;
  code?: ApiErrorCode;
  responsePreview?: string;
}

/** 页面上下文只用于全页翻译；划词/输入框请求不携带，避免额外 token */
export interface TranslationContext {
  title?: string;
  description?: string;
  content?: string;
}

export interface TranslateRequestMessage {
  type: "translate";
  id: string;
  texts: string[];
  targetLang: string;
  context?: TranslationContext;
  /** 翻译会话 id（引擎 generation）：还原时按会话批量中止在途请求，避免浪费额度/算力 */
  sessionId?: number;
}

/** 中止某个翻译会话的在途请求（content → background，还原/换页时发出） */
export interface CancelTranslationMessage {
  type: "cancel-translation";
  sessionId: number;
}

export interface TranslateResponseMessage {
  id: string;
  ok: boolean;
  results?: string[];
  error?: string;
  errorCode?: ApiErrorCode;
  diagnostic?: ApiDiagnostic;
}

export interface TestConnectionRequestMessage {
  type: "test-connection";
  id: string;
  api: ApiConfig;
}

export interface TestConnectionResponseMessage {
  id: string;
  ok: boolean;
  message?: string;
  error?: string;
  errorCode?: ApiErrorCode;
  diagnostic?: ApiDiagnostic;
}

/** 快捷键命令：background → content（chrome.commands 中继） */
export interface ItCommandMessage {
  type: "it-command";
  command: "toggle-translate" | "cycle-mode";
}

/** 清空译文缓存（设置页 → background） */
export interface ClearCacheMessage {
  type: "clear-cache";
}

/** 缓存统计（设置页「缓存管理」展示条目数） */
export interface CacheStatsMessage {
  type: "cache-stats";
}

export interface CacheStatsResponseMessage {
  count: number;
  error?: string;
}

/** 手动触发一次过期/超额缓存清理（设置页 → background） */
export interface CleanupCacheMessage {
  type: "cleanup-cache";
}

export interface CleanupCacheResponseMessage {
  ok: boolean;
  removed?: number;
  error?: string;
}

/** 检查一批文本的缓存命中数（content → background，用于决定整页/懒翻译） */
export interface CheckCacheMessage {
  type: "check-cache";
  targetLang: string;
  texts: string[];
}
