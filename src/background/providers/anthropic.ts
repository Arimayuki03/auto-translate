import { postJson } from "./http";
import type { ChatMessage, ChatOptions, ChatResult, Provider } from "./types";

interface AnthropicMessagesResponse {
  content?: Array<{ text?: string }>;
}

/** Anthropic Claude：POST {base}/v1/messages */
export const anthropicProvider: Provider = {
  format: "anthropic",
  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    const rest = messages.filter((m) => m.role !== "system");
    const data = await postJson<AnthropicMessagesResponse>(
      `${options.baseUrl}/v1/messages`,
      {
        "x-api-key": options.apiKey,
        "anthropic-version": "2023-06-01",
      },
      {
        model: options.model,
        max_tokens: 4096,
        system,
        messages: rest,
        temperature: options.temperature,
      },
      options.timeoutMs
    );
    const text = data?.content?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error("响应格式异常：未找到 content[0].text");
    }
    return { text };
  },
};