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
  /** 翻译会话中止信号（还原/换页）：桥接到 fetch，在途请求能被立即打断 */
  signal?: AbortSignal;
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
