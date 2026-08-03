import { postJson } from "./http";
import type { ChatMessage, ChatOptions, ChatResult, Provider } from "./types";

interface GeminiGenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

/** Google Gemini：POST {base}/v1beta/models/{model}:generateContent */
export const geminiProvider: Provider = {
  format: "gemini",
  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
    const url = `${options.baseUrl}/v1beta/models/${encodeURIComponent(options.model)}:generateContent?key=${encodeURIComponent(options.apiKey)}`;
    const data = await postJson<GeminiGenerateContentResponse>(
      url,
      {},
      {
        system_instruction: system ? { parts: [{ text: system }] } : undefined,
        contents,
        generationConfig: { temperature: options.temperature },
      },
      options.timeoutMs
    );
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error("响应格式异常：未找到 candidates[0].content.parts[0].text");
    }
    return { text };
  },
};