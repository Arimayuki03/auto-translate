import type { ApiDiagnostic } from "../../shared/messages";
import { ApiError, makeDiagnostic } from "./http";
import type { ChatMessage, ChatOptions, ChatResult, Provider } from "./types";

const DEFAULT_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const GOOGLE_CONCURRENCY = 3;
const MIN_START_INTERVAL_MS = 80;

let activeRequests = 0;
let nextStartAt = 0;
const waiting: Array<() => void> = [];

/** 目标语言归一化为 Google 语言码（zh-CN/zh-TW/ja/ko/en…） */
function toGoogleLang(lang: string): string {
  const l = lang.trim();
  if (/^zh-?(cn|hans|sg)/i.test(l)) return "zh-CN";
  if (/^zh-?(tw|hk|mo|hant)/i.test(l)) return "zh-TW";
  return l.split(/[-_]/)[0].toLowerCase() || "auto";
}

/** 从消息里提取目标语言：系统提示词含「翻译为X」，失败回退中文 */
function extractTargetLang(messages: ChatMessage[]): string {
  const sys = messages.find((m) => m.role === "system")?.content ?? "";
  const m = sys.match(/翻译为([^，。\s]+)/);
  return m?.[1] ?? "zh-CN";
}

/** 从消息里提取待译片段；分隔协议由 TranslateService 显式传入，避免猜测正文内容。 */
function extractSegments(messages: ChatMessage[], options: ChatOptions): string[] {
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  if ((options.batchSize ?? 1) <= 1) return [user];
  if (options.batchMode === "separator" && options.batchSeparator) {
    return user
      .split(options.batchSeparator)
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }
  return user.split(/\r?\n/).map((s) => s.trim());
}

/** Google translate_a/single 的实际响应：[[[译文, 原文], ...], ...] */
type GoogleResponse = Array<Array<[string, string, ...unknown[]]> | unknown> | unknown;

interface GoogleTranslationResult {
  text: string;
  diagnostic: ApiDiagnostic;
}

async function acquireSlot(): Promise<void> {
  if (activeRequests >= GOOGLE_CONCURRENCY) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  activeRequests++;
  const now = Date.now();
  const startAt = Math.max(now, nextStartAt);
  nextStartAt = startAt + MIN_START_INTERVAL_MS;
  const delay = startAt - now;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

function releaseSlot(): void {
  activeRequests--;
  // 用指针索引代替 shift()（shift 是 O(n)）
  const resolver = waiting[waitingHead];
  if (resolver) {
    waiting[waitingHead++] = undefined as unknown as () => void;
    resolver();
    if (waitingHead >= waiting.length) {
      waiting.length = 0;
      waitingHead = 0;
    }
  }
}
let waitingHead = 0;

function buildGoogleUrl(endpoint: string, text: string, tl: string): string {
  const url = new URL(endpoint || DEFAULT_ENDPOINT);
  url.searchParams.set("client", url.searchParams.get("client") || "gtx");
  url.searchParams.set("dt", url.searchParams.get("dt") || "t");
  url.searchParams.set("sl", url.searchParams.get("sl") || "auto");
  url.searchParams.set("tl", tl);
  url.searchParams.set("q", text);
  return url.toString();
}

/** 单次 GET 翻译一段（Google 免费端点，无需 key）。
 *  signal：翻译会话中止信号（还原/换页），桥接到 fetch 打断在途请求。 */
async function gTranslate(
  endpoint: string,
  text: string,
  tl: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<GoogleTranslationResult> {
  let url: string;
  try {
    url = buildGoogleUrl(endpoint, text, tl);
  } catch {
    throw new ApiError(
      "bad_request",
      "Google 免费翻译端点格式无效",
      makeDiagnostic("googlefree", endpoint, { code: "bad_request" })
    );
  }
  await acquireSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 会话中止桥接：还原/换页时立即打断在途 fetch（区分超时与会话中止，中止不当作失败上报）
  const onSessionAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onSessionAbort);
  }
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      if (signal?.aborted) throw new Error("cancelled");
      throw new ApiError(
        "timeout",
        `Google 免费翻译请求超时（${Math.round(timeoutMs / 1000)}s）`,
        makeDiagnostic("googlefree", url, { code: "timeout" })
      );
    }
    throw new ApiError(
      "network",
      `Google 免费翻译网络不可达：${err instanceof Error ? err.message : String(err)}`,
      makeDiagnostic("googlefree", url, { code: "network" })
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onSessionAbort);
    releaseSlot();
  }
  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    const code =
      res.status === 429
        ? "rate_limit"
        : res.status >= 500
          ? "server"
          : res.status === 404
            ? "not_found"
            : "bad_request";
    const label = code === "rate_limit" ? "频率限制" : code === "server" ? "服务端错误" : "请求失败";
    throw new ApiError(code, `Google 免费翻译${label}（${res.status}）`, {
      ...makeDiagnostic("googlefree", url, {
        status: res.status,
        responsePreview: raw.slice(0, 300),
      }),
      code,
    });
  }
  let data: GoogleResponse;
  try {
    data = JSON.parse(raw) as GoogleResponse;
  } catch {
    throw new ApiError("bad_response", "Google 免费翻译响应不是有效 JSON", {
      ...makeDiagnostic("googlefree", url, {
        status: res.status,
        responsePreview: raw.slice(0, 300),
      }),
      code: "bad_response",
    });
  }
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new ApiError("bad_response", "Google 免费翻译响应格式异常", {
      ...makeDiagnostic("googlefree", url, { status: res.status }),
      code: "bad_response",
    });
  }
  const translated = (data[0] as unknown[])
    .filter(
      (item): item is [string, string, ...unknown[]] =>
        Array.isArray(item) && typeof item[0] === "string"
    )
    .map((item) => item[0])
    .join("");
  if (!translated) {
    throw new ApiError("bad_response", "Google 免费翻译返回空结果", {
      ...makeDiagnostic("googlefree", url, { status: res.status }),
      code: "bad_response",
    });
  }
  return {
    text: translated,
    diagnostic: makeDiagnostic("googlefree", url, { status: res.status }),
  };
}

async function translateWithFallback(
  endpoints: string[],
  text: string,
  tl: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<GoogleTranslationResult> {
  let lastError: unknown;
  for (let i = 0; i < endpoints.length; i++) {
    try {
      return await gTranslate(endpoints[i], text, tl, timeoutMs, signal);
    } catch (err) {
      // 会话中止（非 ApiError）不换端点重试，直接上抛
      if (!(err instanceof ApiError)) throw err;
      lastError = err;
      const canFallback =
        err instanceof ApiError &&
        (err.retryable || err.code === "not_found" || err.code === "bad_response");
      if (!canFallback || i === endpoints.length - 1) throw err;
    }
  }
  throw lastError;
}

/**
 * Google 免费翻译通道（translate.googleapis.com 公开端点）。
 * - 无需 API Key、无需模型；天然支持批量（并发请求各段，用哨兵拼回由上层解析）。
 * - 稳定免费但有频率限制，故此处并发刻意压低（≤3），避免触发 429。
 */
export const googleFreeProvider: Provider = {
  format: "googlefree",
  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    // 目标语言优先用显式传入值（避免从中文提示词正则反解的脆弱性），缺省回退消息解析
    const tl = toGoogleLang(options.targetLang ?? extractTargetLang(messages));
    const segments = extractSegments(messages, options).filter((s) => s.trim() !== "");
    const endpoints = [options.freeEndpoint?.trim() || DEFAULT_ENDPOINT];
    const backup = options.freeBackupEndpoint?.trim();
    if (backup && backup !== endpoints[0]) endpoints.push(backup);
    const out: string[] = new Array(segments.length);
    let diagnostic: ApiDiagnostic | undefined;
    let i = 0;
    async function worker(): Promise<void> {
      while (i < segments.length) {
        const idx = i++;
        const result = await translateWithFallback(
          endpoints,
          segments[idx],
          tl,
          options.timeoutMs,
          options.signal
        );
        out[idx] = result.text;
        diagnostic ??= result.diagnostic;
      }
    }
    await Promise.all(Array.from({ length: Math.min(GOOGLE_CONCURRENCY, segments.length) }, worker));
    const separator = options.batchSeparator ?? "===IT_SEP===";
    return {
      text: options.batchMode === "separator" ? out.join(`\n${separator}\n`) : out.join("\n"),
      diagnostic,
    };
  },
};
