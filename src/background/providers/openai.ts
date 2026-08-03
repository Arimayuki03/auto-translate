import { postJson } from "./http";
import type { ChatMessage, ChatOptions, ChatResult, Provider } from "./types";

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/** OpenAI 兼容：POST {base}/chat/completions */
export const openaiProvider: Provider = {
  format: "openai",
  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    const data = await postJson<OpenAIChatResponse>(
      `${options.baseUrl}/chat/completions`,
      { Authorization: `Bearer ${options.apiKey}` },
      {
        model: options.model,
        messages,
        temperature: options.temperature,
        stream: false,
      },
      options.timeoutMs
    );
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new Error("响应格式异常：未找到 choices[0].message.content");
    }
    return { text };
  },
};