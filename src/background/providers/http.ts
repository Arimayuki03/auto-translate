import type { ApiDiagnostic, ApiErrorCode } from "../../shared/messages";
import type { ApiFormat } from "../../shared/types";

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
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onSessionAbort);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const safeText = redactSecrets(text, url, headers).slice(0, 300);
    const error = classifyError(provider, url, res.status, safeText, res.headers.get("Retry-After") ?? undefined);
    console.warn("[auto-translate] API 请求失败", error.diagnostic, error.message);
    throw error;
  }
  return {
    data: (await res.json()) as T,
    diagnostic: makeDiagnostic(provider, url, { status: res.status }),
  };
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

function redactSecrets(text: string, url: string, headers: Record<string, string>): string {
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
