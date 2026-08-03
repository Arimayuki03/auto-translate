import type { ApiFormat } from "../../shared/types";

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
}

export interface ChatResult {
  text: string;
}

/** 统一的多格式 API 适配器接口 */
export interface Provider {
  readonly format: ApiFormat;
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult>;
}