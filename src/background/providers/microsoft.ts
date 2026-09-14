import type { ApiDiagnostic } from "../../shared/messages";
import { ApiError, makeDiagnostic } from "./http";
import { extractSegments, extractTargetLang } from "./segments";
import type { ChatMessage, ChatOptions, ChatResult, Provider } from "./types";

/**
 * Microsoft 免 key 翻译通道（edge.microsoft.com 公开端点，无需 API Key / 模型）。
 * 与 Google 免费通道互补：一个被限流（429）时另一个通常仍可用，TranslateService
 * 在两者之间自动互切（未配置备用 API 时）。
 *
 * 端点说明（对照 read-frog microsoft.ts）：
 * - 请求体是「裸 JSON 字符串数组」，旧版 [{ Text }] 形态会被拒绝；
 * - 端点会对每次请求跑 HTML 标签对齐器：正文里裸的 "<" 会被融合成伪标签
 *   （如 "a < b" 返回 "<B 和 b"），因此发送前必须转义 & < >，返回后解码一次；
 * - 响应为与请求等长的数组，每项 { translations: [{ text }] }。
 */
const MICROSOFT_ENDPOINT = "https://edge.microsoft.com/translate/translatetext";
/** 单次请求携带的最大段数：端点对超长请求体可能拒绝，分批发送 */
const MAX_SEGMENTS_PER_REQUEST = 50;
/** 请求启动间隔（毫秒）：免费端点，与 googlefree 同样压低速率防 429 */
const MIN_START_INTERVAL_MS = 300;

/** 微软端点源语言归一：端点不认裸 zh，必须传具体变体——检测层保留的 zh-TW 落到
 *  zh-Hant；简体/未知变体的 zh 按 zh-Hans 传；非 zh 取主码 */
function toMicrosoftSourceLang(lang: string): string {
  const primary = lang.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  if (primary === "zh") {
    return /^zh.*(tw|hk|hant)/i.test(lang) ? "zh-Hant" : "zh-Hans";
  }
  return primary;
}

/** 目标语言归一化为 Microsoft 语言码（zh-Hans / zh-Hant / ja / ko / en…） */
function toMicrosoftLang(lang: string): string {
  const l = lang.trim();
  if (/^zh-?(cn|hans|sg)/i.test(l)) return "zh-Hans";
  if (/^zh-?(tw|hk|mo|hant)/i.test(l)) return "zh-Hant";
  return l.split(/[-_]/)[0].toLowerCase() || "en";
}

/** HTML 实体转义：防裸 < 被端点的标签对齐器吃掉（& 必须最先转义） */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 解码一次转义实体（与 escapeHtml 配对；&amp; 放最后，保证 &amp;lt; → &lt; 而不是 <） */
function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

interface MicrosoftTranslation {
  translations?: Array<{ text?: string }>;
}

async function requestTranslate(
  texts: string[],
  from: string,
  to: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string[]> {
  const url = `${MICROSOFT_ENDPOINT}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&isEnterpriseClient=false`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 会话中止桥接：还原/换页时立即打断在途 fetch（与 googlefree 同一套约定）
  const onSessionAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onSessionAbort);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(texts.map(escapeHtml)),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      if (signal?.aborted) throw new Error("cancelled");
      throw new ApiError(
        "timeout",
        `Microsoft 免费翻译请求超时（${Math.round(timeoutMs / 1000)}s）`,
        makeDiagnostic("microsoft", url, { code: "timeout" })
      );
    }
    throw new ApiError(
      "network",
      `Microsoft 免费翻译网络不可达：${err instanceof Error ? err.message : String(err)}`,
      makeDiagnostic("microsoft", url, { code: "network" })
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onSessionAbort);
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
    throw new ApiError(code, `Microsoft 免费翻译${label}（${res.status}）`, {
      ...makeDiagnostic("microsoft", url, {
        status: res.status,
        responsePreview: raw.slice(0, 300),
      }),
      code,
    });
  }
  let data: MicrosoftTranslation[];
  try {
    data = JSON.parse(raw) as MicrosoftTranslation[];
  } catch {
    throw new ApiError("bad_response", "Microsoft 免费翻译响应不是有效 JSON", {
      ...makeDiagnostic("microsoft", url, { status: res.status, responsePreview: raw.slice(0, 300) }),
      code: "bad_response",
    });
  }
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new ApiError(
      "bad_response",
      `Microsoft 免费翻译响应段数不符（期望 ${texts.length}，实际 ${Array.isArray(data) ? data.length : "非数组"}）`,
      { ...makeDiagnostic("microsoft", url, { status: res.status }), code: "bad_response" }
    );
  }
  return data.map((item, i) => {
    const text = item?.translations?.[0]?.text;
    if (typeof text !== "string") {
      throw new ApiError("bad_response", `Microsoft 免费翻译第 ${i + 1} 段返回空结果`, {
        ...makeDiagnostic("microsoft", url, { status: res.status }),
        code: "bad_response",
      });
    }
    return unescapeHtml(text);
  });
}

/** 免费端点请求启动限速：相邻请求最小间隔（googlefree 同思路，独立计数） */
let nextStartAt = 0;
async function acquireStartSlot(): Promise<void> {
  const now = Date.now();
  const startAt = Math.max(now, nextStartAt);
  nextStartAt = startAt + MIN_START_INTERVAL_MS;
  const delay = startAt - now;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Microsoft 免费翻译通道：无需 API Key；端点原生支持批量（一个请求携带全部段）。
 * 固定使用安全哨兵协议拼回输出（与 googlefree 一致，ApiConfig.batchMode 对免费通道不生效）。
 */
export const microsoftProvider: Provider = {
  format: "microsoft",
  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
    const tl = toMicrosoftLang(options.targetLang ?? extractTargetLang(messages));
    // from 留空 = 自动检测源语言
    const segments = extractSegments(messages, options).filter((s) => s.trim() !== "");
    if (segments.length === 0) return { text: "" };
    const out: string[] = [];
    let diagnostic: ApiDiagnostic | undefined;
    for (let start = 0; start < segments.length; start += MAX_SEGMENTS_PER_REQUEST) {
      const group = segments.slice(start, start + MAX_SEGMENTS_PER_REQUEST);
      await acquireStartSlot();
      // from 留空 = 端点自动检测；用户强制/页面检测出源语言时显式传入
      const from = options.sourceLang ? toMicrosoftSourceLang(options.sourceLang) : "";
      const translated = await requestTranslate(group, from, tl, options.timeoutMs, options.signal);
      out.push(...translated);
    }
    const separator = options.batchSeparator ?? "===IT_SEP===";
    return {
      text: options.batchMode === "separator" ? out.join(`\n${separator}\n`) : out.join("\n"),
      diagnostic,
    };
  },
};
