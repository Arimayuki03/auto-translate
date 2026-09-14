import type { ApiDiagnostic } from "../../shared/messages";
import type { ApiFormat, BatchMode } from "../../shared/types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  batchMode?: BatchMode;
  batchSeparator?: string;
  batchSize?: number;
  freeEndpoint?: string;
  freeBackupEndpoint?: string;
  /** 目标语言：免费通道直接使用，避免从提示词反解（缺省回退 provider 内部解析） */
  targetLang?: string;
  /** 源语言（html lang / 启发式 / 用户强制）：免费通道据此设 sl/from；空/缺省 = 端点自动检测 */
  sourceLang?: string;
  /** 翻译会话中止信号（还原/换页）：桥接到 fetch，在途请求能被立即打断 */
  signal?: AbortSignal;
  /** 流式输出（划词气泡）：设置后支持流式的 provider 走 SSE 增量返回并把增量回调给 onDelta，
   *  ChatResult.text 仍是完整全文；流式失败（未产出增量）由 provider 回退非流式重试一次。
   *  免费通道（googlefree/microsoft）不支持流式，忽略该选项整段一次性返回。 */
  stream?: { onDelta: (delta: string) => void };
}

export interface ChatResult {
  text: string;
  diagnostic?: ApiDiagnostic;
}

/** 统一的多格式 API 适配器接口 */
export interface Provider {
  readonly format: ApiFormat;
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult>;
}
