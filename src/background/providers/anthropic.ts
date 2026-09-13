import type { ApiDiagnostic } from "../../shared/messages";
import {
  ApiError,
  buildApiUrl,
  makeDiagnostic,
  postJson,
  postSSE,
  withStreamFallback,
} from "./http";
import type { ChatMessage, ChatOptions, ChatResult, Provider } from "./types";

interface AnthropicMessagesResponse {
  content?: Array<{ text?: string }>;
}

/** 流式事件：只消费 content_block_delta 里的 text_delta（thinking 等其余事件忽略） */
interface AnthropicStreamEvent {
  type?: string;
  delta?: { type?: string; text?: string };
  error?: { message?: string };
}

/** 输出预算随输入放大（与 F-7 非流式一致）；返回请求体公共部分 */
function buildBody(options: ChatOptions, system: string, rest: ChatMessage[], stream: boolean) {
  const inputChars = rest.reduce((n, m) => n + m.content.length, 0);
  return {
    model: options.model,
    max_tokens: Math.min(8192, Math.max(4096, Math.ceil(inputChars / 2))),
    system,
    messages: rest,
    temperature: options.temperature,
    ...(stream ? { stream: true } : {}),
  };
}

/** 非流式请求（原实现，含 F-7 的 4096 回退）：POST {base}/v1/messages */
async function chatOnce(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
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
  const wantMaxTokens = Math.min(
    8192,
    Math.max(4096, Math.ceil(rest.reduce((n, m) => n + m.content.length, 0) / 2))
  );
  let data: AnthropicMessagesResponse;
  let diagnostic: ApiDiagnostic | undefined;
  try {
    ({ data, diagnostic } = await postJson<AnthropicMessagesResponse>(
      url,
      headers,
      buildBody(options, system, rest, false),
      options.timeoutMs,
      "anthropic",
      options.signal
    ));
  } catch (err) {
    // 部分模型输出上限恰为 4096（如 claude-3-haiku）：400 拒绝时降回 4096 重试一次；
    // 预算本就是 4096 时重试无意义（与 F-7 的守卫一致）
    const overBudget =
      err instanceof ApiError && err.code === "bad_request" && /max_tokens/i.test(err.message);
    if (!overBudget || wantMaxTokens <= 4096) throw err;
    ({ data, diagnostic } = await postJson<AnthropicMessagesResponse>(
      url,
      headers,
      { ...buildBody(options, system, rest, false), max_tokens: 4096 },
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
}

/** SSE 流式请求：content_block_delta(text_delta) 增量回调 onDelta，返回拼接后的全文 */
async function chatStream(
  messages: ChatMessage[],
  options: ChatOptions,
  onDelta: (delta: string) => void
): Promise<ChatResult> {
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
  let text = "";
  const diagnostic = await postSSE(
    url,
    headers,
    buildBody(options, system, rest, true),
    options.timeoutMs,
    "anthropic",
    options.signal,
    (payload) => {
      let evt: AnthropicStreamEvent;
      try {
        evt = JSON.parse(payload) as AnthropicStreamEvent;
      } catch {
        return; // 心跳/注释等非 JSON 负载：跳过
      }
      if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
        const delta = evt.delta.text;
        if (typeof delta === "string" && delta) {
          text += delta;
          onDelta(delta);
        }
      } else if (evt.type === "error") {
        throw new ApiError(
          "server",
          `流式响应返回错误：${evt.error?.message ?? "unknown"}`,
          makeDiagnostic("anthropic", url, { code: "server" })
        );
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

/** Anthropic Claude：POST {base}/v1/messages（设置 stream 时走 SSE，失败回退非流式一次） */
export const anthropicProvider: Provider = {
  format: "anthropic",
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    return withStreamFallback(
      options,
      (onDelta) => chatStream(messages, options, onDelta),
      () => chatOnce(messages, options)
    );
  },
};
