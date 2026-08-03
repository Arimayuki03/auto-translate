export type ApiErrorCode =
  | "auth"
  | "not_found"
  | "rate_limit"
  | "server"
  | "bad_request"
  | "timeout"
  | "network";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  /** 是否可重试（网络/超时/限流/5xx 可重试；鉴权/404/参数错误不重试） */
  readonly retryable: boolean;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.code = code;
    this.retryable =
      code === "rate_limit" || code === "server" || code === "network" || code === "timeout";
  }
}

export async function postJson<T = Record<string, unknown>>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      throw new ApiError("timeout", `请求超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    throw new ApiError("network", `网络错误：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw classifyError(res.status, text);
  }
  return (await res.json()) as T;
}

function classifyError(status: number, text: string): ApiError {
  if (status === 401 || status === 403) {
    return new ApiError("auth", "鉴权失败（401/403）：请检查 API Key");
  }
  if (status === 404) {
    return new ApiError("not_found", "地址或路径错误（404）：请检查 BaseURL 与 API 格式");
  }
  if (status === 429) {
    return new ApiError("rate_limit", "触发限流（429）：请求过于频繁");
  }
  if (status >= 500) {
    return new ApiError("server", `服务端错误（${status}）`);
  }
  return new ApiError("bad_request", `请求失败（${status}）：${text.slice(0, 200)}`);
}