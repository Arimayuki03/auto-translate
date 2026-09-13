import { ApiError, buildApiUrl, makeDiagnostic, postJson, postSSE, withStreamFallback } from "./http";
import type { ChatMessage, ChatOptions, ChatResult, Provider } from "./types";

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/** 流式增量帧：choices[0].delta.content；部分兼容中转在流内回 error 帧 */
interface OpenAIStreamChunk {
  choices?: Array<{ delta?: { content?: string } }>;
  error?: { message?: string };
}

/** 非流式请求（原实现）：POST {base}/chat/completions，stream:false */
async function chatOnce(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
  const url = buildApiUrl(options.baseUrl, "/chat/completions");
  const { data, diagnostic } = await postJson<OpenAIChatResponse>(
    url,
    { Authorization: `Bearer ${options.apiKey}` },
    {
      model: options.model,
      messages,
      temperature: options.temperature,
      stream: false,
    },
    options.timeoutMs,
    "openai",
    options.signal
  );
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new ApiError("bad_response", "响应格式异常：未找到 choices[0].message.content", {
      ...diagnostic,
      code: "bad_response",
    });
  }
  return { text, diagnostic };
}

/** SSE 流式请求：增量帧 choices[0].delta.content 逐段回调 onDelta，返回拼接后的全文 */
async function chatStream(
  messages: ChatMessage[],
  options: ChatOptions,
  onDelta: (delta: string) => void
): Promise<ChatResult> {
  const url = buildApiUrl(options.baseUrl, "/chat/completions");
  let text = "";
  const diagnostic = await postSSE(
    url,
    { Authorization: `Bearer ${options.apiKey}` },
    {
      model: options.model,
      messages,
      temperature: options.temperature,
      stream: true,
    },
    options.timeoutMs,
    "openai",
    options.signal,
    (payload) => {
      if (payload === "[DONE]") return;
      let chunk: OpenAIStreamChunk;
      try {
        chunk = JSON.parse(payload) as OpenAIStreamChunk;
      } catch {
        return; // 心跳/注释等非 JSON 负载：跳过，流结束后仍校验是否拿到文本
      }
      if (chunk.error) {
        throw new ApiError(
          "server",
          `流式响应返回错误：${chunk.error.message ?? "unknown"}`,
          makeDiagnostic("openai", url, { code: "server" })
        );
      }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        text += delta;
        onDelta(delta);
      }
    }
  );
  if (!text) {
    throw new ApiError("bad_response", "流式响应未返回任何文本", {
      ...diagnostic,
      code: "bad_response",
    });
  }
  return { text, diagnostic };
}

/** OpenAI 兼容：POST {base}/chat/completions（设置 stream 时走 SSE，失败回退非流式一次） */
export const openaiProvider: Provider = {
  format: "openai",
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    return withStreamFallback(
      options,
      (onDelta) => chatStream(messages, options, onDelta),
      () => chatOnce(messages, options)
    );
  },
};
