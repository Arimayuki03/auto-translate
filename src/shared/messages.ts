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

/** 页面上下文只用于全页翻译；划词/输入框请求不携带，避免额外 token。
 *  summary 为 LLM 生成的文章摘要（长文页整页翻译期间异步补充，带缓存）；缺省时只用原文截断。 */
export interface TranslationContext {
  title?: string;
  description?: string;
  content?: string;
  summary?: string;
  /** 页面源语言（html lang / 启发式 / 用户强制）：提示词语境 + 免费通道 sl/from 参数 */
  sourceLang?: string;
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

// ===== LLM 页面上下文摘要（content → background，整页翻译期间异步补充）=====

/** 生成/读取页面文章摘要（背景按「标题+正文+配置」哈希查缓存，未命中才请求 LLM）。
 *  失败静默返回空摘要：content 侧保持原文截断上下文，不阻塞也不报错。 */
export interface PageSummaryRequestMessage {
  type: "page-summary";
  id: string;
  title: string;
  /** 发送侧已按 contextMaxChars 截断的正文文本 */
  content: string;
  /** 随整页翻译会话中止（还原/换页时不再浪费这次请求） */
  sessionId?: number;
}

export interface PageSummaryResponseMessage {
  id: string;
  ok: boolean;
  summary?: string;
  error?: string;
}

// ===== 划词流式翻译（Port 长连接协议）=====

/** Port 名：content 划词翻译时 chrome.runtime.connect({ name }) 建立长连接 */
export const STREAM_PORT_NAME = "it-stream";

/** content → background（Port 建立后的首条消息）：发起一次流式翻译 */
export interface StreamStartMessage {
  type: "stream-start";
  text: string;
  targetLang: string;
}

/** background → content：增量文本（自上一条消息以来新增的部分） */
export interface StreamDeltaMessage {
  type: "stream-delta";
  delta: string;
}

/** background → content：流正常结束；text 为完整译文（以它为准覆盖增量累积） */
export interface StreamDoneMessage {
  type: "stream-done";
  text: string;
}

/** background → content：流失败（错误类型 / 脱敏诊断与 translate 消息同语义） */
export interface StreamErrorMessage {
  type: "stream-error";
  error: string;
  errorCode?: ApiErrorCode;
  diagnostic?: ApiDiagnostic;
}

/** Port 上流转的全部消息形态 */
export type StreamPortMessage =
  | StreamStartMessage
  | StreamDeltaMessage
  | StreamDoneMessage
  | StreamErrorMessage;

// ===== 划词朗读 TTS（content → background → offscreen 播放）=====

/** 合成一段语音（Edge TTS 免费，background 完成；声音/语速按设置解析） */
export interface TtsSynthesizeMessage {
  type: "tts-synthesize";
  id: string;
  text: string;
  /** 目标语言（气泡译文的语言，用于自动选声音）：zh-CN / en / ja / ko … */
  targetLang: string;
}

export interface TtsSynthesizeResponseMessage {
  id: string;
  ok: boolean;
  /** MP3 音频的 base64（audio-24khz-48kbitrate-mono-mp3） */
  audioBase64?: string;
  contentType?: string;
  error?: string;
}

/** 播放已合成的音频（background 转发到 offscreen 文档；响应在播放结束/被停止时回） */
export interface TtsPlayMessage {
  type: "tts-play";
  id: string;
  /** 播放请求 id：仅用于标识一次播放，停止时全局只停当前一条 */
  requestId: string;
  audioBase64: string;
  contentType: string;
}

export interface TtsPlayResponseMessage {
  id: string;
  ok: boolean;
  /** true = 播放完成；false + error = 播放失败 */
  finished?: boolean;
  error?: string;
}

/** 停止当前播放（气泡关闭 / 点「停止」时发出；无在途播放时为 no-op） */
export interface TtsStopMessage {
  type: "tts-stop";
}

export interface TtsStopResponseMessage {
  ok: boolean;
}
