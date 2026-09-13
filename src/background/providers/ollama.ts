import { ApiError, buildApiUrl, postJson, postNDJSONLines, withStreamFallback } from "./http";
import type { ChatMessage, ChatOptions, ChatResult, Provider } from "./types";

interface OllamaChatResponse {
  message?: { content?: string };
}

/** 流式增量行：每行一个 JSON 对象，message.content 为增量文本（末行 done:true） */
interface OllamaStreamLine {
  message?: { content?: string };
}

/** 非流式请求（原实现）：POST {base}/api/chat，stream:false */
async function chatOnce(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
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
}

/** NDJSON 流式请求：逐行解析 message.content 增量回调 onDelta，返回拼接后的全文 */
async function chatStream(
  messages: ChatMessage[],
  options: ChatOptions,
  onDelta: (delta: string) => void
): Promise<ChatResult> {
  const url = buildApiUrl(options.baseUrl, "/api/chat");
  let text = "";
  const diagnostic = await postNDJSONLines(
    url,
    {},
    {
      model: options.model,
      stream: true,
      messages,
      options: { temperature: options.temperature },
    },
    options.timeoutMs,
    "ollama",
    options.signal,
    (line) => {
      let evt: OllamaStreamLine;
      try {
        evt = JSON.parse(line) as OllamaStreamLine;
      } catch {
        return; // 非 JSON 行（进度/心跳）：跳过
      }
      const delta = evt.message?.content;
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

/** Ollama 原生：POST {base}/api/chat（设置 stream 时走 NDJSON 增量流） */
export const ollamaProvider: Provider = {
  format: "ollama",
  chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    return withStreamFallback(
      options,
      (onDelta) => chatStream(messages, options, onDelta),
      () => chatOnce(messages, options)
    );
  },
};
