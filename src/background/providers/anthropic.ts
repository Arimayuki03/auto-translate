import type { ApiDiagnostic } from "../../shared/messages";
import { ApiError, buildApiUrl, postJson } from "./http";
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
    const url = buildApiUrl(options.baseUrl, "/v1/messages");
    const headers = {
      "x-api-key": options.apiKey,
      "anthropic-version": "2023-06-01",
    };
    const body = (maxTokens: number) => ({
      model: options.model,
      max_tokens: maxTokens,
      system,
      messages: rest,
      temperature: options.temperature,
    });
    // 输出预算随输入放大（译文与输入同量级）：批量 60 段长文按 4096 截断会让批量解析
    // 失败而整批作废。封顶 8192；部分模型输出上限恰为 4096（如 claude-3-haiku），
    // 被 400（bad_request 且消息含 max_tokens）拒绝时降回 4096 重试一次。
    const inputChars = rest.reduce((n, m) => n + m.content.length, 0);
    const wantMaxTokens = Math.min(8192, Math.max(4096, Math.ceil(inputChars / 2)));
    let data: AnthropicMessagesResponse;
    let diagnostic: ApiDiagnostic | undefined;
    try {
      ({ data, diagnostic } = await postJson<AnthropicMessagesResponse>(
        url,
        headers,
        body(wantMaxTokens),
        options.timeoutMs,
        "anthropic",
        options.signal
      ));
    } catch (err) {
      const overBudget =
        err instanceof ApiError && err.code === "bad_request" && /max_tokens/i.test(err.message);
      if (!overBudget || wantMaxTokens <= 4096) throw err;
      ({ data, diagnostic } = await postJson<AnthropicMessagesResponse>(
        url,
        headers,
        body(4096),
        options.timeoutMs,
        "anthropic",
        options.signal
      ));
    }
    const text = data?.content?.[0]?.text;
    if (typeof text !== "string") {
      throw new ApiError("bad_response", "响应格式异常：未找到 content[0].text", {
        ...diagnostic,
        code: "bad_response",
      });
    }
    return { text, diagnostic };
  },
};
