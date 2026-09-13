import { ApiError, buildApiUrl, postJson, postSSE, withStreamFallback } from "./http";
import type { ChatMessage, ChatOptions, ChatResult, Provider } from "./types";

interface GeminiGenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

/** 构造请求体公共部分（system 抽到 system_instruction，其余按 role 映射为 contents） */
function buildBody(messages: ChatMessage[], temperature: number) {
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
  return {
    system_instruction: system ? { parts: [{ text: system }] } : undefined,
    contents,
    generationConfig: { temperature },
  };
}

/** 构造带 key 查询参数的接口 URL（stream 为 true 时用 SSE 版 streamGenerateContent） */
function buildUrl(options: ChatOptions, stream: boolean): string {
  const url = new URL(
    buildApiUrl(
      options.baseUrl,
      `/v1beta/models/${encodeURIComponent(options.model)}:${
        stream ? "streamGenerateContent" : "generateContent"
      }`
    )
  );
  // alt=sse：SSE 增量协议（缺省时 streamGenerateContent 返回一次性 JSON 数组，不是流）
  if (stream) url.searchParams.set("alt", "sse");
  url.searchParams.set("key", options.apiKey);
  return url.toString();
}

/** 非流式请求（原实现）：POST {base}/v1beta/models/{model}:generateContent */
async function chatOnce(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
  const { data, diagnostic } = await postJson<GeminiGenerateContentResponse>(
    buildUrl(options, false),
    {},
    buildBody(messages, options.temperature),
    options.timeoutMs,
    "gemini",
    options.signal
  );
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    throw new ApiError(
      "bad_response",
      "响应格式异常：未找到 candidates[0].content.parts[0].text",
      { ...diagnostic, code: "bad_response" }
    );
  }
  return { text, diagnostic };
}

/** SSE 流式请求：每个 data 帧与 generateContent 同构，candidates[0].content.parts 文本增量拼接 */
async function chatStream(
  messages: ChatMessage[],
  options: ChatOptions,
  onDelta: (delta: string) => void
): Promise<ChatResult> {
  let text = "";
  const diagnostic = await postSSE(
    buildUrl(options, true),
    {},
    buildBody(messages, options.temperature),
    options.timeoutMs,
    "gemini",
    options.signal,
    (payload) => {
      let evt: GeminiGenerateContentResponse;
      try {
        evt = JSON.parse(payload) as GeminiGenerateContentResponse;
      } catch {
        return; // 心跳/注释等非 JSON 负载：跳过
      }
      const parts = evt.candidates?.[0]?.content?.parts;
      if (!Array.isArray(parts)) return;
      for (const part of parts) {
        if (typeof part?.text === "string" && part.text) {
          text += part.text;
          onDelta(part.text);
        }
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

/** Google Gemini：POST {base}/v1beta/models/{model}:generateContent（设置 stream 时走 SSE） */
export const geminiProvider: Provider = {
  format: "gemini",
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    return withStreamFallback(
      options,
      (onDelta) => chatStream(messages, options, onDelta),
      () => chatOnce(messages, options)
    );
  },
};
