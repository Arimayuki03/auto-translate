import type { ApiDiagnostic, ApiErrorCode } from "../../shared/messages";
import type { ApiFormat } from "../../shared/types";
import type { ChatOptions, ChatResult } from "./types";

export interface HttpResult<T> {
  data: T;
  diagnostic: ApiDiagnostic;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly diagnostic?: ApiDiagnostic;
  /** 是否可重试（网络/超时/限流/5xx 可重试；鉴权/404/参数错误不重试） */
  readonly retryable: boolean;
  /** 服务端 Retry-After / Retry-After-Ms 头给出的等待时长（毫秒）；无头时为空。
   *  重试策略优先尊重该时长（如 429 后 provider 明确要求冷却），避免瞎猜。 */
  readonly retryAfterMs?: number;

  constructor(code: ApiErrorCode, message: string, diagnostic?: ApiDiagnostic, retryAfterMs?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.diagnostic = diagnostic;
    this.retryAfterMs = retryAfterMs;
    this.retryable =
      code === "rate_limit" || code === "server" || code === "network" || code === "timeout";
  }
}

/** 安全拼接 BaseURL 与接口路径：自动去重 /v1beta 等重叠路径，也接受用户填完整接口地址。
 *  空/非法 BaseURL 抛清晰 ApiError（bad_request），避免 new URL 的 TypeError 被当作网络错误上报。 */
export function buildApiUrl(baseUrl: string, endpointPath: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new ApiError("bad_request", "BaseURL 为空：请先在设置中填写 API 地址");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ApiError("bad_request", "BaseURL 格式无效，请检查协议与地址（如 https://api.example.com/v1）");
  }
  const baseParts = url.pathname.split("/").filter(Boolean);
  const endpointParts = endpointPath.split("/").filter(Boolean);
  let overlap = 0;
  const max = Math.min(baseParts.length, endpointParts.length);
  for (let n = max; n > 0; n--) {
    if (baseParts.slice(-n).join("/") === endpointParts.slice(0, n).join("/")) {
      overlap = n;
      break;
    }
  }
  url.pathname = `/${[...baseParts, ...endpointParts.slice(overlap)].join("/")}`;
  return url.toString();
}

/** 查询参数可能包含 Gemini Key；诊断端点只保留协议、主机与路径。 */
export function makeDiagnostic(
  provider: ApiFormat,
  rawUrl: string,
  extras: Partial<Omit<ApiDiagnostic, "provider" | "endpoint" | "hostname">> = {}
): ApiDiagnostic {
  let endpoint = rawUrl;
  let hostname = "";
  try {
    const url = new URL(rawUrl);
    hostname = url.hostname;
    endpoint = `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    endpoint = rawUrl.split(/[?#]/, 1)[0];
  }
  return { provider, endpoint, hostname, ...extras };
}

/** 为错误补充主/备用来源，同时保持原错误分类与可重试语义。 */
export function withErrorSource(err: unknown, source: "main" | "backup"): unknown {
  if (!(err instanceof ApiError)) return err;
  const label = source === "main" ? "主 API" : "备用 API";
  return new ApiError(err.code, `${label}${err.message}`, {
    ...(err.diagnostic ?? makeDiagnostic("openai", "")),
    source,
    code: err.code,
  });
}

export async function postJson<T = Record<string, unknown>>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  provider: ApiFormat,
  signal?: AbortSignal
): Promise<HttpResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 会话中止（还原/换页）也要能打断在途 fetch：把外部 signal 桥接到超时 controller 上
  const onSessionAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onSessionAbort);
  }
  // 响应体读取（含 !res.ok 错误体与主路径正文）必须留在超时/中止作用域内：
  // 只计时到响应头到达的话，卡死的 body 依然会让 promise 永不 settle（A1）。
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        // 区分超时与会话中止：中止是用户主动行为，抛普通 Error（非 ApiError），
        // 不触发重试/备用切换，由上层归一化为 TranslationCancelledError
        if (signal?.aborted) throw new Error("cancelled");
        throw new ApiError(
          "timeout",
          `请求超时（${Math.round(timeoutMs / 1000)}s）`,
          makeDiagnostic(provider, url, { code: "timeout" })
        );
      }
      throw new ApiError(
        "network",
        `网络错误：${err instanceof Error ? err.message : String(err)}`,
        makeDiagnostic(provider, url, { code: "network" })
      );
    }
    // 读体 AbortError（超时/中止打断悬挂 body）：与 fetch 阶段同一套分类
    const readBodyOrAbort = (p: Promise<string>): Promise<string> =>
      p.catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") {
          if (signal?.aborted) throw new Error("cancelled");
          throw new ApiError(
            "timeout",
            `请求超时（${Math.round(timeoutMs / 1000)}s）`,
            makeDiagnostic(provider, url, { code: "timeout" })
          );
        }
        // 读体本身失败（连接中断等）是可重试的网络错误，不得吞成空串（B2）
        throw new ApiError(
          "network",
          `读取响应体失败：${err instanceof Error ? err.message : String(err)}`,
          makeDiagnostic(provider, url, { code: "network" })
        );
      });

    if (!res.ok) {
      // 错误体只用于诊断展示，读不到（含中止/超时打断）就空串按状态码归类
      const text = await res.text().catch(() => "");
      const safeText = redactSecrets(text, url, headers).slice(0, 300);
      const error = classifyError(provider, url, res.status, safeText, res.headers.get("Retry-After") ?? undefined);
      console.warn("[auto-translate] API 请求失败", error.diagnostic, error.message);
      throw error;
    }
    const raw = await readBodyOrAbort(res.text());
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      // 中转站返回 HTML/空体等非 JSON 内容：包成 bad_response 走统一错误分级与脱敏诊断
      // （此前裸抛 SyntaxError，无诊断、不归类，用户只看到 "Unexpected token ..."）
      throw new ApiError(
        "bad_response",
        "响应不是有效 JSON（请检查 BaseURL 是否指向正确的 API 端点）",
        {
          ...makeDiagnostic(provider, url, {
            status: res.status,
            responsePreview: redactSecrets(raw, url, headers).slice(0, 300),
          }),
          code: "bad_response",
        }
      );
    }
    return {
      data: data as T,
      diagnostic: makeDiagnostic(provider, url, { status: res.status }),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onSessionAbort);
  }
}

/**
 * 流式 POST 的公共骨架：超时 / 会话中止 / 错误分级与 postJson 完全同一套约定
 * （中止抛普通 Error("cancelled")，不触发重试/备用切换），把响应正文增量喂给 onText。
 * 仅错误分级与读流归 postBodyStream 管，协议解析（SSE / NDJSON）由上层包装完成。
 */
async function postBodyStream(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  provider: ApiFormat,
  signal: AbortSignal | undefined,
  onText: (text: string) => void
): Promise<ApiDiagnostic> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 会话中止桥接：与 postJson 相同（中止打断在途 fetch 与读流）
  const onSessionAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onSessionAbort);
  }
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        if (signal?.aborted) throw new Error("cancelled");
        throw new ApiError(
          "timeout",
          `请求超时（${Math.round(timeoutMs / 1000)}s）`,
          makeDiagnostic(provider, url, { code: "timeout" })
        );
      }
      throw new ApiError(
        "network",
        `网络错误：${err instanceof Error ? err.message : String(err)}`,
        makeDiagnostic(provider, url, { code: "network" })
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const safeText = redactSecrets(text, url, headers).slice(0, 300);
      const error = classifyError(provider, url, res.status, safeText, res.headers.get("Retry-After") ?? undefined);
      console.warn("[auto-translate] API 请求失败", error.diagnostic, error.message);
      throw error;
    }
    if (!res.body) {
      throw new ApiError("bad_response", "流式响应无正文", {
        ...makeDiagnostic(provider, url, { status: res.status }),
        code: "bad_response",
      });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    // 读流失败（网络中断/超时中止）按可重试错误归类；onText 回调抛出的业务错误原样上抛
    const readChunk = async (): Promise<Uint8Array | null> => {
      try {
        const { done, value } = await reader.read();
        return done ? null : value;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          if (signal?.aborted) throw new Error("cancelled");
          throw new ApiError(
            "timeout",
            `请求超时（${Math.round(timeoutMs / 1000)}s）`,
            makeDiagnostic(provider, url, { code: "timeout" })
          );
        }
        throw new ApiError(
          "network",
          `流式响应中断：${err instanceof Error ? err.message : String(err)}`,
          makeDiagnostic(provider, url, { code: "network" })
        );
      }
    };
    try {
      for (;;) {
        const chunk = await readChunk();
        if (!chunk) break;
        // stream:true 处理跨 chunk 被切断的多字节字符
        onText(decoder.decode(chunk, { stream: true }));
      }
      onText(decoder.decode()); // 冲出解码器尾字节
    } finally {
      // 提前退出（业务错误/会话中止）时释放连接，不让响应体悬挂
      reader.cancel().catch(() => undefined);
    }
    return makeDiagnostic(provider, url, { status: res.status });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onSessionAbort);
  }
}

/** SSE 流式 POST：按空行切事件，把每个事件的 data 负载回调给 onData
 *  （[DONE] 帧原样透传由调用方处理；兼容 CRLF 分隔与跨 chunk 切断的事件边界）。 */
export async function postSSE(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  provider: ApiFormat,
  signal: AbortSignal | undefined,
  onData: (payload: string) => void
): Promise<ApiDiagnostic> {
  let buf = "";
  const dispatch = (event: string): void => {
    // 一个事件可含多行 data:（SSE 规范按换行拼接）；event:/id:/注释行忽略
    const data = event
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) onData(data);
  };
  const feed = (text: string): void => {
    buf += text;
    // 结尾的孤立 \r 可能是 CRLF 的前半（\n 在下一个 chunk），先暂存待下轮回填后统一归一
    let hold = "";
    if (buf.endsWith("\r")) {
      hold = "\r";
      buf = buf.slice(0, -1);
    }
    buf = buf.split("\r\n").join("\n") + hold;
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      dispatch(event);
    }
  };
  const diagnostic = await postBodyStream(url, headers, body, timeoutMs, provider, signal, feed);
  // 流结束：处理最后一个未以空行收尾的事件（dispatch 内部保证无 data 行时不误发）
  if (buf.trim()) dispatch(buf);
  return diagnostic;
}

/** NDJSON 流式 POST（Ollama /api/chat stream）：逐行回调非空行 */
export async function postNDJSONLines(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  provider: ApiFormat,
  signal: AbortSignal | undefined,
  onLine: (line: string) => void
): Promise<ApiDiagnostic> {
  let buf = "";
  const feed = (text: string): void => {
    buf += text;
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) onLine(line);
    }
  };
  const diagnostic = await postBodyStream(url, headers, body, timeoutMs, provider, signal, feed);
  const rest = buf.trim();
  if (rest) onLine(rest);
  return diagnostic;
}

/**
 * 流式 → 非流式回退包装：onDelta 缺省直接走非流式；流式失败且尚未产出任何增量时，
 * 仅「疑似不支持流式」（不支持流式的端点/中转兼容性，或网络层失败）才回退非流式重试一次。
 * rate_limit / auth 属于明确的服务端拒绝：回退只会多打一发请求——429 在退避生效前
 * 冲击已限流端点，401 把硬失败的请求量翻倍——故直接上抛交上层重试/切换逻辑处理。
 * 已产出增量再回退会让调用方收到「前半段 + 重新开始的整段」重复文本，只能上抛交上层展示错误；
 * 会话已中止同样不回退（回退请求会立刻被打断）。
 */
export async function withStreamFallback(
  options: ChatOptions,
  runStream: (onDelta: (delta: string) => void) => Promise<ChatResult>,
  runNonStream: () => Promise<ChatResult>
): Promise<ChatResult> {
  const outer = options.stream?.onDelta;
  if (!outer) return runNonStream();
  let emitted = false;
  try {
    return await runStream((delta) => {
      emitted = true;
      outer(delta);
    });
  } catch (err) {
    if (emitted || options.signal?.aborted) throw err;
    // 疑似不支持流式（not_found/bad_request/bad_response）或网络层失败才回退；
    // rate_limit/auth 是明确拒绝，回退无意义（直接上抛）
    const fallbackable =
      !(err instanceof ApiError) ||
      err.code === "not_found" ||
      err.code === "bad_request" ||
      err.code === "bad_response" ||
      err.code === "network" ||
      err.code === "timeout";
    if (!fallbackable) throw err;
    return runNonStream();
  }
}

function classifyError(
  provider: ApiFormat,
  url: string,
  status: number,
  text: string,
  retryAfterHeader?: string
): ApiError {
  const base = makeDiagnostic(provider, url, { status, responsePreview: text });
  const retryAfterMs = parseRetryAfter(retryAfterHeader);
  if (status === 401 || status === 403) {
    return new ApiError("auth", "鉴权失败（401/403）：请检查 API Key", {
      ...base,
      code: "auth",
    });
  }
  if (status === 404) {
    return new ApiError("not_found", "地址或路径错误（404）：请检查 BaseURL 与 API 格式", {
      ...base,
      code: "not_found",
    });
  }
  if (status === 429) {
    return new ApiError(
      "rate_limit",
      "触发限流（429）：请求过于频繁",
      { ...base, code: "rate_limit" },
      retryAfterMs
    );
  }
  if (status >= 500) {
    return new ApiError("server", `服务端错误（${status}）`, { ...base, code: "server" }, retryAfterMs);
  }
  return new ApiError("bad_request", `请求失败（${status}）：${text.slice(0, 200)}`, {
    ...base,
    code: "bad_request",
  });
}

/** 解析 Retry-After 头为等待毫秒：支持秒数或 HTTP 日期；无法解析返回 undefined（走退避兜底） */
function parseRetryAfter(header: string | undefined): number | undefined {
  if (!header) return undefined;
  const seconds = Number.parseFloat(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(header.trim());
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

/** 将 text 中出现的密钥（鉴权头值 / Bearer / URL key 参数）替换为 [REDACTED]：
 *  流内错误消息、诊断预览等任何可能到达 UI 的文本都必须先过这里。 */
export function redactSecrets(text: string, url: string, headers: Record<string, string>): string {
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (/authorization|api-key/i.test(name)) {
      secrets.add(value);
      secrets.add(value.replace(/^Bearer\s+/i, ""));
    }
  }
  try {
    const parsed = new URL(url);
    for (const key of ["key", "api_key", "apikey", "token"]) {
      const value = parsed.searchParams.get(key);
      if (value) secrets.add(value);
    }
  } catch {
    // 非法 URL 会在 fetch 或 provider 层报错；这里仅负责尽力脱敏。
  }
  // 一次正则替换所有密钥，避免每个密钥都做一次 split+join（O(secrets × 文本长度)）
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}
