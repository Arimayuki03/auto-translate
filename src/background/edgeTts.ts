/**
 * Edge TTS 免费合成（对照 read-frog 的实现链路）：
 * 1. 用 MSTranslatorAndroidApp 的 HMAC-SHA256 签名向 dev.microsofttranslator.com 换取
 *    端点令牌（JWT，{t, r}，约 10 分钟过期，缓存复用）；
 * 2. 携带令牌把 SSML POST 到区域端点 cognitiveservices/v1 合成 MP3，全程无需 API Key。
 * 附带熔断：10 分钟窗口内 5 次失败后熔断 15 分钟，避免 Edge TTS 不可用时反复打端点。
 * 本模块不引用 chrome.* 顶层 API，可在单测中直接导入（设置在 synthesizeSpeech 内读取）。
 */

// ===== 常量（与 Edge 客户端公开签名材料一致） =====

const SIGNATURE_SECRET_BASE64 =
  "oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==";
const SIGNATURE_APP_ID = "MSTranslatorAndroidApp";
const ENDPOINT_URL = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
const CLIENT_VERSION = "4.0.530a 5fe1dc6c";
const USER_ID = "0f04d16a175c411e";
const HOME_REGION = "zh-Hans-CN";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0";

export const TTS_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
/** 单次合成文本上限（字符）：划词气泡译文远小于此，仅防御异常巨型选区 */
export const TTS_MAX_TEXT_CHARS = 3000;
/** 令牌提前 3 分钟刷新；取不到 exp 时按 10 分钟兜底 */
const TOKEN_REFRESH_BEFORE_EXPIRY_MS = 3 * 60 * 1000;
const TOKEN_DEFAULT_TTL_MS = 10 * 60 * 1000;

// ===== 声音映射：目标语言 → Edge TTS 神经声音 =====

export const VOICE_BY_LANG: Record<string, string> = {
  "zh-CN": "zh-CN-XiaoxiaoNeural",
  "zh-TW": "zh-TW-HsiaoChenNeural",
  "zh-HK": "zh-HK-HiuMaanNeural",
  en: "en-US-AvaNeural",
  ja: "ja-JP-NanamiNeural",
  ko: "ko-KR-SunHiNeural",
  fr: "fr-FR-DeniseNeural",
  de: "de-DE-KatjaNeural",
  es: "es-ES-ElviraNeural",
  it: "it-IT-ElsaNeural",
  pt: "pt-BR-FranciscaNeural",
  ru: "ru-RU-SvetlanaNeural",
  ar: "ar-SA-ZariyahNeural",
  vi: "vi-VN-HoaiMyNeural",
  th: "th-TH-PremwadeeNeural",
  id: "id-ID-GadisNeural",
};
const DEFAULT_VOICE = "en-US-AvaNeural";

/** 解析朗读声音：用户显式指定 > 目标语言精确匹配 > 语言前缀匹配（en-GB → en）> 默认 */
export function resolveTtsVoice(targetLang: string, userVoice?: string): string {
  const v = (userVoice ?? "").trim();
  if (v) return v;
  const lang = (targetLang ?? "").trim();
  if (VOICE_BY_LANG[lang]) return VOICE_BY_LANG[lang];
  const prefix = lang.split(/[-_]/)[0]?.toLowerCase() ?? "";
  return VOICE_BY_LANG[prefix] ?? DEFAULT_VOICE;
}

// ===== SSML =====

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** 清除 XML 控制字符并做 XML 转义（& < > " '） */
function escapeXmlText(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    // 0x9 制表 / 0xA 换行 / 0xD 回车合法，其余 C0 控制字符与孤 surrogate 替换为空格
    const isControl =
      (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || (cp >= 0x7f && cp < 0xa1);
    out += isControl ? " " : (XML_ESCAPES[ch] ?? ch);
  }
  return out;
}

/** 属性值转义（voice 名 / locale） */
function escapeXmlAttribute(s: string): string {
  return s.replace(/[<>&"']/g, (c) => XML_ESCAPES[c] ?? c);
}

export function buildSSML(text: string, voice: string, ratePercent: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("朗读内容为空");
  const locale = voice.split("-").slice(0, 2).join("-") || "en-US";
  const rate = Math.min(100, Math.max(-100, Math.round(ratePercent)));
  const rateStr = rate >= 0 ? `+${rate}%` : `${rate}%`;
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXmlAttribute(locale)}">` +
    `<voice name="${escapeXmlAttribute(voice)}">` +
    `<prosody rate="${rateStr}">${escapeXmlText(clean)}</prosody>` +
    `</voice></speak>`
  );
}

// ===== 端点令牌（缓存 + JWT exp 解析） =====

interface EndpointToken {
  /** Authorization 头直接使用的 JWT */
  token: string;
  /** 区域（如 eastus），拼合成端点主机 */
  region: string;
  expiredAt: number;
}

let cachedToken: EndpointToken | null = null;

function decodeJwtExpiryMs(token: string): number | null {
  const payload = token.split(".")[1] ?? "";
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    const exp = JSON.parse(json)?.exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function randomTraceId(): string {
  const uuid = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : String(Date.now());
  return uuid.replace(/-/g, "");
}

async function hmacSha256Base64(keyBase64: string, data: string): Promise<string> {
  const key = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** MSTranslatorAndroidApp 签名：HMAC(payload) → `appid::sig::date::requestId` */
async function generateTranslatorSignature(now = new Date()): Promise<string> {
  const encodedUrl = encodeURIComponent(ENDPOINT_URL.split("://")[1] ?? "");
  const date = `${now.toUTCString().replace(/GMT/, "").trim().toLowerCase()} GMT`;
  const requestId = randomTraceId();
  const payload = `${SIGNATURE_APP_ID}${encodedUrl}${date}${requestId}`.toLowerCase();
  const sig = await hmacSha256Base64(SIGNATURE_SECRET_BASE64, payload);
  return `${SIGNATURE_APP_ID}::${sig}::${date}::${requestId}`;
}

/** 外部请求硬超时：没有超时的话，网络挂起会让 promise 永不 settle ——
 *  keepAlive 一直被续命、并发槽被永久占用，划词气泡无限转圈。 */
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
/** 单次合成请求的计时窗口（含音频响应体读完）。令牌失效重发另起独立窗口，
 *  避免「首次请求耗尽大半窗口后 401 → 重发只剩零头」把一次可恢复的失败变成超时。 */
const SYNTH_REQUEST_TIMEOUT_MS = 30_000;

/** 在硬超时内执行一段请求逻辑：signal 透传给 fetch，run 内部请把响应体也读完——
 *  只计时到响应头到达的话，卡死的流式 body 依然会让 promise 永不 settle。
 *  只在「超时先于业务错误发生」时才替换成超时错误：run 自己抛的错（HTTP 4xx、
 *  响应格式无效等）带真实原因，不能被笼统的超时文案吞掉。 */
async function withRequestTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (controller.signal.aborted && isAbortError(err)) {
      throw new Error(`Edge TTS 请求超时（${timeoutMs}ms）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** fetch 收到 abort 时抛 DOMException("AbortError")；其余错误与超时无关，原样上抛 */
function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

async function getEndpointToken(): Promise<EndpointToken> {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY_MS) {
    return cachedToken;
  }
  const signature = await generateTranslatorSignature();
  const data = await withRequestTimeout(TOKEN_REQUEST_TIMEOUT_MS, async (signal) => {
    const res = await fetch(ENDPOINT_URL, {
      method: "POST",
      headers: {
        "Accept-Language": "zh-Hans",
        "X-ClientVersion": CLIENT_VERSION,
        "X-UserId": USER_ID,
        "X-HomeGeographicRegion": HOME_REGION,
        "X-ClientTraceId": randomTraceId(),
        "X-MT-Signature": signature,
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: "",
      signal,
    });
    if (!res.ok) {
      throw new Error(`Edge TTS 令牌获取失败（HTTP ${res.status}）`);
    }
    return (await res.json()) as { t?: unknown; r?: unknown };
  });
  if (typeof data.t !== "string" || typeof data.r !== "string" || !data.t || !data.r) {
    throw new Error("Edge TTS 令牌响应格式无效");
  }
  cachedToken = {
    token: data.t,
    region: data.r,
    expiredAt: decodeJwtExpiryMs(data.t) ?? now + TOKEN_DEFAULT_TTL_MS,
  };
  return cachedToken;
}

// ===== 熔断：窗口内失败计数 → 开路 =====

const CIRCUIT_WINDOW_MS = 10 * 60 * 1000;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 15 * 60 * 1000;

let failureTimestamps: number[] = [];
let circuitOpenUntil = 0;

export function isEdgeTTSCircuitOpen(now = Date.now()): boolean {
  return circuitOpenUntil > now;
}

export function resetEdgeTTSCircuitBreaker(): void {
  failureTimestamps = [];
  circuitOpenUntil = 0;
}

function recordTtsFailure(now = Date.now()): void {
  const threshold = now - CIRCUIT_WINDOW_MS;
  failureTimestamps = failureTimestamps.filter((ts) => ts >= threshold);
  failureTimestamps.push(now);
  if (failureTimestamps.length >= CIRCUIT_FAILURE_THRESHOLD) {
    circuitOpenUntil = now + CIRCUIT_OPEN_MS;
    failureTimestamps = [];
  }
}

function recordTtsSuccess(): void {
  failureTimestamps = [];
  circuitOpenUntil = 0;
}

// ===== 合成 =====

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // 分块拼装避免 String.fromCharCode(...bytes) 在长音频上超出调用栈
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 401/403 = 令牌失效：清缓存让下次重新获取（也供测试复位模块状态） */
export function clearEdgeTTSTokenCache(): void {
  cachedToken = null;
}

export interface TtsSynthOptions {
  /** 用户显式指定的声音（设置项 tts.voice，空 = 自动） */
  userVoice?: string;
  /** 语速百分比（-100 ~ 100，设置项 tts.rate） */
  rate?: number;
}

/**
 * 合成一段文本为 MP3（base64）。文本超出 TTS_MAX_TEXT_CHARS 时截断。
 * 失败计入熔断；熔断开启时直接抛错，不再请求 Edge TTS 端点。
 */
export async function synthesizeSpeech(
  text: string,
  targetLang: string,
  opts?: TtsSynthOptions
): Promise<{ audioBase64: string; contentType: string }> {
  if (isEdgeTTSCircuitOpen()) {
    throw new Error("朗读服务暂时不可用（连续失败熔断中），请稍后再试");
  }
  const clipped = text.length > TTS_MAX_TEXT_CHARS ? text.slice(0, TTS_MAX_TEXT_CHARS) : text;
  const voice = resolveTtsVoice(targetLang, opts?.userVoice);
  const ssml = buildSSML(clipped, voice, opts?.rate ?? 0);
  try {
    const audio = await synthOnce(ssml);
    recordTtsSuccess();
    return { audioBase64: arrayBufferToBase64(audio), contentType: "audio/mpeg" };
  } catch (err) {
    recordTtsFailure();
    throw err instanceof Error ? err : new Error(String(err));
  }
}

async function synthOnce(ssml: string): Promise<ArrayBuffer> {
  let token = await getEndpointToken();
  // 重发用独立计时窗口：若与首次请求共用一个 30s 作用域，首次请求耗尽大半窗口后
  // 返回 401，重发只剩零头时间，一次可恢复的令牌失效会被误报成超时。
  return withRequestTimeout(SYNTH_REQUEST_TIMEOUT_MS, async (signal) => {
    let res = await postSSML(token, ssml, signal);
    if ((res.status === 401 || res.status === 403) && !cachedTokenInvalidated(token)) {
      // 令牌可能已失效：清缓存重取一次（仅一次，避免风暴），重发单独计时
      clearEdgeTTSTokenCache();
      token = await getEndpointToken();
      return withRequestTimeout(SYNTH_REQUEST_TIMEOUT_MS, (retrySignal) =>
        finishSynthFrom(postSSML(token, ssml, retrySignal))
      );
    }
    return finishSynthFrom(Promise.resolve(res));
  });
}

/** 合成响应收尾：非 2xx 报错、空音频报错。挂在计时作用域内调用，
 *  保证音频响应体也在窗口内读完（卡死的 body 同样不放过）。 */
async function finishSynthFrom(pending: Promise<Response>): Promise<ArrayBuffer> {
  const res = await pending;
  if (!res.ok) {
    throw new Error(`Edge TTS 合成失败（HTTP ${res.status}）`);
  }
  const audio = await res.arrayBuffer();
  if (audio.byteLength === 0) {
    throw new Error("Edge TTS 返回了空音频（当前声音可能不支持该语言）");
  }
  return audio;
}

function cachedTokenInvalidated(token: EndpointToken): boolean {
  return cachedToken !== token;
}

function postSSML(
  token: EndpointToken,
  ssml: string,
  signal: AbortSignal
): Promise<Response> {
  return fetch(`https://${token.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      Authorization: token.token,
      "Content-Type": "application/ssml+xml",
      "User-Agent": USER_AGENT,
      "X-Microsoft-OutputFormat": TTS_OUTPUT_FORMAT,
    },
    body: ssml,
    signal,
  });
}
