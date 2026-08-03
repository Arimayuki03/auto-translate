import { postJson } from "./http";
import type { ChatMessage, ChatOptions, ChatResult, Provider } from "./types";

interface OllamaChatResponse {
  message?: { content?: string };
}

/** Ollama 原生：POST {base}/api/chat */
export const ollamaProvider: Provider = {
  format: "ollama",
  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    const data = await postJson<OllamaChatResponse>(
      `${options.baseUrl}/api/chat`,
      {},
      {
        model: options.model,
        stream: false,
        messages,
        options: { temperature: options.temperature },
      },
      options.timeoutMs
    );
    const text = data?.message?.content;
    if (typeof text !== "string") {
      throw new Error("响应格式异常：未找到 message.content");
    }
    return { text };
  },
};