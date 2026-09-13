import { ApiError, buildApiUrl, postJson } from "./http";
import type { ChatMessage, ChatOptions, ChatResult, Provider } from "./types";

interface OllamaChatResponse {
  message?: { content?: string };
}

/** Ollama 原生：POST {base}/api/chat */
export const ollamaProvider: Provider = {
  format: "ollama",
  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    const url = buildApiUrl(options.baseUrl, "/api/chat");
    const { data, diagnostic } = await postJson<OllamaChatResponse>(
      url,
      {},
      {
        model: options.model,
        stream: false,
        messages,
        options: { temperature: options.temperature },
      },
      options.timeoutMs,
      "ollama",
      options.signal
    );
    const text = data?.message?.content;
    if (typeof text !== "string") {
      throw new ApiError("bad_response", "响应格式异常：未找到 message.content", {
        ...diagnostic,
        code: "bad_response",
      });
    }
    return { text, diagnostic };
  },
};
