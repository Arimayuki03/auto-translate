import type { ApiConfig, BatchMode, Settings } from "../shared/types";
import type { TranslationContext } from "../shared/messages";
import { getSettings } from "../shared/storage";
import { TranslationCache, SummaryCache, fnv1aHex } from "./cache";
import { TokenBucket } from "./rateLimiter";
import { ApiError, withErrorSource } from "./providers/http";
import { withSourceLangContext } from "../shared/langDetect";
import { createProvider } from "./providers";
import type { ChatMessage, ChatOptions } from "./providers/types";

const MAX_RETRIES = 3;
/** 普通可重试错误（网络/超时/5xx）的退避上限：指数退避封顶，防止无限拉长 */
const MAX_RETRY_DELAY_MS = 60_000;
/** 429 无 Retry-After 头时的固定冷却窗口：并发重试不必各自加倍，一个稳妥窗口足够 */
const RATE_LIMIT_BASE_PAUSE_MS = 1_000;
/** 尊重服务端 Retry-After 的上限（超长冷却兜底） */
const MAX_RETRY_AFTER_MS = 5 * 60_000;

/** 批量/免费通道相关的透传参数（主备通道共用，协议在调用侧决定、provider 侧执行） */
type BatchChatOptions = Pick<
  ChatOptions,
  | "batchMode"
  | "batchSeparator"
  | "batchSize"
  | "freeEndpoint"
  | "freeBackupEndpoint"
  | "targetLang"
  | "sourceLang"
  | "signal"
>;

/** 翻译会话被中止（还原/换页）：区别于 API 错误，不应触发重试/备用切换，也不上报为失败 */
export class TranslationCancelledError extends Error {
  constructor() {
    super("翻译已取消");
    this.name = "TranslationCancelledError";
  }
}

/** 批量分隔哨兵：模型按此分隔符逐段输出，解析按哨兵 split（比按行数匹配鲁棒得多） */
export const BATCH_SEPARATOR = "===IT_SEP===";

/** 免译哨兵：批量输出「严格等于」该值（忽略首尾空白）的段，返回原文代替译文
 *  （该段本身已是目标语言 / 代码 / 公式 / 编号 / 专有名词等，不硬译；未来方向 三.5） */
export const NO_TRANSLATION_SENTINEL = "{{NO_TRANSLATION_NEEDED}}";

/** LLM 页面摘要的系统提示词：摘要只注入翻译上下文（帮助模型理解长文语境），
 *  不套用用户自定义翻译指令——那是给「译文输出」定的规则，与摘要无关。 */
export const SUMMARY_SYSTEM_PROMPT =
  "你是专业的文章摘要引擎。请用 2-3 句话概括文章的主题与关键信息，只输出摘要本身，不要解释、不要任何前缀、引号或格式。";

/** 摘要输出上限：超长多半是模型没遵守指令，截断保底（上下文注入也不该太长） */
const MAX_SUMMARY_CHARS = 600;

/** 批量解析失败时的二次降级组大小：先拆成 ≤8 段的小批量重试——小批量输出短、
 *  解析成功率高，把最坏情况的请求数从 N 压到约 N/8；仍失败的组才逐段。 */
const SUB_BATCH_SIZE = 8;

/** 免 key 免费通道集合：同一时刻主用其一，另一个作为自动互切的备份 */
const FREE_FORMATS = ["googlefree", "microsoft"] as const;

/** 未配置备用 API 且主通道是免费通道时，返回另一个免费通道作为 429/不可达时的自动互切目标。
 *  用户显式配置了备用 API 则尊重用户选择（备用可能是任意格式），返回 null。 */
export function freeSiblingApi(settings: Settings): ApiConfig | null {
  if (settings.backupApi) return null;
  if (!FREE_FORMATS.includes(settings.api.format as (typeof FREE_FORMATS)[number])) return null;
  const sibling = FREE_FORMATS.find((f) => f !== settings.api.format)!;
  return { ...settings.api, format: sibling };
}

/**
 * 请求超时按字符数缩放：base + 15ms/字符（封顶 max(base, 120s)）。
 * 批量请求的生成时间随字符数线性增长，固定 60s 超时会把「还在正常生成」的大批
 * 误判为超时重试，反而放大请求量（借鉴 read-frog batch-queue）。
 */
export function scaleTimeoutMs(baseMs: number, chars: number): number {
  const base = Math.max(1000, baseMs || 60_000);
  return Math.min(base + 15 * Math.max(0, chars), Math.max(base, 120_000));
}

function systemPrompt(targetLang: string): string {
  return `你是专业翻译引擎。将用户输入翻译为${targetLang}，只输出译文，不要解释、不要添加任何额外内容。`;
}

/** 用户自定义附加指令（需求：进阶用户自定义 prompt）：非空时拼在系统提示词最前面；
 *  批量协议指令（逐行 / 哨兵分段规则）始终完整保留在其后，保证批量协议不被用户 prompt 破坏 */
function withCustomPrompt(system: string, custom?: string): string {
  const c = (custom ?? "").trim();
  return c ? `${c}\n\n${system}` : system;
}

/** 免译规则（仅 LLM 通道的批量协议追加；免费通道端点不解析 system 指令，不注入） */
function noTranslationRule(): string {
  return `

## 免译规则（必须严格遵守）
若某段本身已是目标语言、或无需翻译（代码、公式、编号、专有名词等），该段不要硬译：
该段只输出 ${NO_TRANSLATION_SENTINEL}（除该标记外不要输出任何其他内容），其余段落照常翻译，
输出段数与输入完全一致。`;
}

/** 批量哨兵模式的系统提示词：在原规则之上追加哨兵规则（仅 batchMode="separator" 使用；
 *  第三方模型对自定义协议的服从度参差，默认逐行协议兼容性最好） */
function sentinelSystemPrompt(targetLang: string): string {
  return `${systemPrompt(targetLang)}

## 批量分段规则（必须严格遵守）
1. 输入由多个待译片段组成，片段之间用单独一行的 ${BATCH_SEPARATOR} 分隔。
2. 逐段翻译，段数与输入完全一致，输出也用单独一行的 ${BATCH_SEPARATOR} 分隔各段译文。
3. 绝对不要增加、删除、修改、合并或移动 ${BATCH_SEPARATOR} 分隔行；不要给它编号。
4. 每段译文内部不要出现 ${BATCH_SEPARATOR}。`;
}

/** 旧版逐行批量协议的 user 内容（默认兼容模式，请求格式与历史版本完全一致） */
function linesBatchUserContent(texts: string[]): string {
  return `请逐行翻译以下内容，每行一个译文，保持顺序，不要编号，不要任何额外文字：\n${texts.join("\n")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err: unknown): boolean {
  return err instanceof ApiError && err.retryable;
}

/** API 级硬失败（鉴权失败 / 模型不存在 / 参数错误）：与请求粒度无关，
 *  整批、小批量、逐段用的是同一个 Key 与同一份请求体，重发必然同样失败。
 *  这类错误必须短路，否则会把 1 次 401 放大成 1+N 次（见 translateBatch 降级链）。 */
function isHardApiFailure(err: unknown): boolean {
  return err instanceof ApiError && !err.retryable;
}

/** 指数退避 + 抖动：带 ±10% 随机抖动，避免并发重试在同一时刻齐发再次触发限流 */
function backoffDelayMs(attempt: number): number {
  const base = 500 * 2 ** attempt;
  return Math.min(base + Math.random() * 0.1 * base, MAX_RETRY_DELAY_MS);
}

async function withRetry<T>(
  task: () => Promise<T>,
  retries = MAX_RETRIES,
  onRateLimit?: (pauseMs: number) => void
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === retries) {
        throw err;
      }
      // 429：尊重服务端 Retry-After（有头用头，无头用固定冷却窗口）；
      // 其余可重试错误：指数退避 + 抖动
      const retryAfterMs = err instanceof ApiError ? err.retryAfterMs : undefined;
      const isRateLimit = err instanceof ApiError && err.code === "rate_limit";
      const delay = isRateLimit
        ? Math.min(retryAfterMs ?? RATE_LIMIT_BASE_PAUSE_MS, MAX_RETRY_AFTER_MS)
        : backoffDelayMs(attempt);
      // 429 时通知服务把整个限速器暂停（队列级冷却），避免并发兄弟请求继续冲击已限流的 provider
      if (isRateLimit) onRateLimit?.(delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

/** 单个通道（API 格式 + 端点）的限速状态：令牌桶 + 429 队列级冷却 */
interface ChannelLimiter {
  bucket: TokenBucket;
  /** 429 限流暂停：此时间点之前不放行该通道任何新请求（队列级冷却） */
  pausedUntil: number;
}

export class TranslateService {
  /** 相邻两个 provider 请求的最小启动间隔（毫秒）＝请求启动限速。
   *  默认 500（≈2 请求/秒），可在设置页按中转站/服务商额度调整
   *  （settings.api.minRequestIntervalMs，每次 translate 调用时刷新）。 */
  private minRequestIntervalMs = 500;

  private cache = new TranslationCache();
  private cacheEnabled = true;
  /** LLM 页面摘要缓存：与译文缓存同一套 TTL/上限设置，键空间独立 */
  private summaryCache = new SummaryCache();
  /** 摘要缓存变体：只掺影响摘要结果的配置（通道格式/模型）。自定义翻译 prompt 不影响摘要，
   *  不掺入——用户改译文指令不应让所有页面摘要重新生成 */
  private summaryVariant = "";
  /** 摘要生成的跨标签页在途去重：同页多标签同时整页翻译只发一次摘要请求 */
  private summaryInflight = new Map<string, Promise<string>>();
  /** 缓存变体：掺入影响译文结果的配置（通道格式/模型/自定义提示词）。
   *  切换模型或修改 prompt 后旧缓存不再命中，避免「改了设置却像是没生效」的困惑；
   *  术语表不参与——术语占位在 content 侧完成，后台缓存的原文本身已含 ⟦n⟧ token。 */
  private cacheVariant = "";
  private active = 0;
  /** 等待队列：用指针索引代替 shift()（shift 是 O(n)） */
  private pending: Array<() => void> = [];
  private pendingHead = 0;
  /** 请求启动限速：令牌桶。rate = 每 minRequestIntervalMs 一个令牌（长期平均速率的底线），
   *  capacity = 并发上限，允许短时突发但长期速率被钳制（借鉴 read-frog RequestQueue）。
   *  按通道（格式+端点）分桶：免费通道被 429 冷却时不再连带冻结主/备 API 的请求。 */
  private channels = new Map<string, ChannelLimiter>();
  /** 通道新建时套用的默认速率/容量（设置刷新时同步到全部已建通道，见 configureChannels） */
  private channelRate = 2;
  private channelCapacity = 2;
  /** 设置缓存：避免每次翻译请求都读 chrome.storage + 解密 API Key。
   *  监听 chrome.storage.onChanged 自动刷新，设置页改动即时生效。 */
  private cachedSettings: Settings | null = null;
  /** 跨标签页在途请求去重：文本+目标语言相同的并发请求共享同一次执行
   *  （多标签页同时翻同一站点时，后到者直接复用先到者的结果，不重复消耗 API 额度）。
   *  signal 供「共享请求被其他会话中止时，本会话自行重发」判断使用。 */
  private inflight = new Map<string, { promise: Promise<string[]>; signal?: AbortSignal }>();

  /** 跨标签页去重键：目标语言 + 文本列表哈希（上下文不参与——同站点多标签页场景收益最大） */
  private static dedupKey(texts: string[], targetLang: string): string {
    return `${targetLang}|${fnv1aHex(texts.join("\u0000"))}`;
  }

  /** 批量翻译入口（跨标签页去重包装）；signal：本会话中止信号（还原/换页）。 */
  async translate(
    texts: string[],
    targetLang: string,
    context?: TranslationContext,
    signal?: AbortSignal
  ): Promise<string[]> {
    if (signal?.aborted) throw new TranslationCancelledError();
    const key = TranslateService.dedupKey(texts, targetLang);
    const entry = this.inflight.get(key);
    if (entry && !entry.signal?.aborted) {
      try {
        return await entry.promise;
      } catch (err) {
        // 共享请求被其他标签页的会话中止、而本会话仍在翻译 → 自己单独重发一次；
        // 其余错误（或本会话也已中止）原样上抛
        if (!(err instanceof TranslationCancelledError) || signal?.aborted) throw err;
      }
    }
    const promise = this.translateInner(texts, targetLang, context, signal);
    this.inflight.set(key, { promise, signal });
    try {
      return await promise;
    } finally {
      // 仅当条目仍指向本次执行时清除（并发覆盖场景不能误删后发起的请求）
      if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key);
    }
  }

  /** 批量翻译执行体：缓存命中 + 批量合并 + 并发限制 + 主备/免费互切。 */
  private async translateInner(
    texts: string[],
    targetLang: string,
    context?: TranslationContext,
    signal?: AbortSignal
  ): Promise<string[]> {
    if (signal?.aborted) throw new TranslationCancelledError();
    const settings = await this.getSettingsCached();
    this.applyCacheSettings(settings);
    const limit = Math.max(1, settings.api.maxConcurrency || 3);
    // 请求启动限速：速率 = 1/间隔（默认 500ms ≈ 2 请求/秒），容量 = 并发上限（允许短突发）。
    // 间隔按设置刷新（用户可按中转站额度调大），钳制下限防除零。
    const interval = Math.max(50, settings.api.minRequestIntervalMs ?? 500);
    this.minRequestIntervalMs = interval;
    this.configureChannels(1000 / interval, Math.min(limit, 16));
    const results: string[] = new Array(texts.length);
    const toFetch: number[] = [];

    // 并发查缓存：Promise.all 代替串行 await，避免 N 条文本 = N 次串行 IPC
    const cacheChecks = await Promise.all(
      texts.map((t) =>
        this.cacheEnabled ? this.cache.get(targetLang, t, this.cacheVariant) : Promise.resolve(undefined)
      )
    );
    for (let i = 0; i < texts.length; i++) {
      const cached = cacheChecks[i];
      if (cached !== undefined) {
        results[i] = cached;
      } else {
        toFetch.push(i);
      }
    }
    if (toFetch.length === 0) return results;

    // 记录批量/逐段遇到的首个可诊断错误：全部失败时向上抛出，让内容与工具条拿到具体错误类型
    let firstError: unknown;
    /** 待请求段落（{结果下标, 原文}）：整批 → 小批量 → 逐段 三级降级，逐级收窄 */
    let pending: Array<{ idx: number; text: string }> = toFetch.map((idx) => ({
      idx,
      text: texts[idx],
    }));
    if (pending.length > 1) {
      if (signal?.aborted) throw new TranslationCancelledError();
      // 按配置的批量协议合并请求。默认逐行（旧版，第三方兼容性最好）：
      //   - lines：解析失败直接进入小批量/逐段降级（哨兵协议不支持时不应反复试探）。
      //   - separator：解析失败先回退一次旧版逐行协议（仍是一次请求），两者都不行才降级。
      // 原文里若本身含哨兵字符串，哨兵分段必然产生歧义 → 强制逐行协议，避免切错段
      const sentinelCollision = pending.some((p) => p.text.includes(BATCH_SEPARATOR));
      const configured = !sentinelCollision && (settings.api.batchMode ?? "lines") === "separator";
      const modes = configured ? (["separator", "lines"] as BatchMode[]) : (["lines"] as BatchMode[]);
      /** 按当前 modes 顺序尝试一次批量。返回 null = 响应成功但解析失败（模型/格式问题，
       *  值得拆小批量重试）；抛错 = API 失败（服务问题，拆小批量无济于事，不应重试）。 */
      const attemptBatch = async (
        items: Array<{ idx: number; text: string }>
      ): Promise<string[] | null> => {
        for (const mode of modes) {
          const batch = await this.runConcurrent(limit, () =>
            this.callApi(
              settings,
              items.map((p) => p.text),
              targetLang,
              { batch: true, batchMode: mode, context, signal }
            )
          );
          const parts = splitBatch(batch, items.length);
          if (parts) return parts;
        }
        return null;
      };
      const commitBatch = async (
        items: Array<{ idx: number; text: string }>,
        parts: string[]
      ): Promise<void> => {
        for (let k = 0; k < items.length; k++) {
          // 免译哨兵映射：该段输出「严格等于」{{NO_TRANSLATION_NEEDED}} → 返回原文代替译文
          const translated = mapNoTranslationNeeded(items[k].text, parts[k]);
          results[items[k].idx] = translated;
          await this.storeCache(targetLang, items[k].text, translated);
        }
      };

      let batchParseFailed = false;
      try {
        // 整批一次请求（批量越大越省 token：系统提示词 + 页面上下文不重复携带）
        const parts = await attemptBatch(pending);
        if (parts) {
          await commitBatch(pending, parts);
          pending = [];
        } else {
          batchParseFailed = true;
        }
      } catch (err) {
        // API 失败：错误先记下，若降级后仍全失败则上抛
        if (!firstError) firstError = err;
        // 硬失败短路：鉴权/404/参数错误下，逐段降级只会把 1 次 401 变成 1+N 次，
        // 每次还要过一遍请求启动限速（默认 500ms），既烧风控又拖死页面。
        // 可重试类（429/5xx/网络/超时）保留降级——小批量确实可能挤过限流。
        if (isHardApiFailure(err)) throw err;
      }

      // 仅「响应正常但解析失败」才值得拆小批量；API 报错（鉴权/网络/限流）拆了也没用
      if (batchParseFailed && pending.length > SUB_BATCH_SIZE) {
        const groups: Array<Array<{ idx: number; text: string }>> = [];
        for (let s = 0; s < pending.length; s += SUB_BATCH_SIZE) {
          groups.push(pending.slice(s, s + SUB_BATCH_SIZE));
        }
        const failed = await Promise.all(
          groups.map(async (group) => {
            try {
              if (signal?.aborted) throw new TranslationCancelledError();
              const parts = await attemptBatch(group);
              if (parts) {
                await commitBatch(group, parts);
                return [] as Array<{ idx: number; text: string }>;
              }
              return group;
            } catch (err) {
              if (!firstError) firstError = err;
              // 同上：硬失败不再往逐段降级带（借 Promise.all 直接中断整批）
              if (isHardApiFailure(err)) throw err;
              return group;
            }
          })
        );
        pending = failed.flat();
      }
    }

    // 逐段降级（最后兜底）：并发受限（一次最多 limit 个请求在途），显著快于串行
    if (signal?.aborted) throw new TranslationCancelledError();
    await Promise.all(
      pending.map(({ idx, text }) =>
        this.runConcurrent(limit, () => {
          if (signal?.aborted) return Promise.reject(new TranslationCancelledError());
          return this.callApi(settings, [text], targetLang, { context, signal });
        })
          .then(async (raw) => {
            const t = mapNoTranslationNeeded(text, raw);
            results[idx] = t;
            await this.storeCache(targetLang, text, t);
          })
          .catch((err) => {
            results[idx] = "";
            if (!firstError) firstError = err;
          })
      )
    );
    // 会话被中止 → 抛中止错误（不触发重试/备用/失败上报）
    if (signal?.aborted) throw new TranslationCancelledError();
    // 需要请求的段落全部失败 → 抛出带错误类型/诊断的错误，而不是静默返回空串
    const allFailed = pending.length > 0 && pending.every(({ idx }) => results[idx] === "");
    if (allFailed && firstError && !(firstError instanceof TranslationCancelledError)) {
      throw firstError;
    }
    if (firstError instanceof TranslationCancelledError) throw firstError;
    return results;
  }

  /**
   * 划词流式翻译（Port 长连接路径）：单段、无页面上下文，增量文本经 onDelta 转发给 Port。
   * 复用整页翻译的缓存 / 请求启动限速 / 并发限制 / 429 队列冷却；
   * 中止（气泡关闭 → Port 断开 → signal）按普通错误处理：归一化为 TranslationCancelledError，
   * 不触发备用切换。免费通道与缓存命中不支持增量，经 stream-done 一次性回传全文。
   */
  async translateStream(
    text: string,
    targetLang: string,
    onDelta: (delta: string) => void,
    signal?: AbortSignal
  ): Promise<string> {
    if (signal?.aborted) throw new TranslationCancelledError();
    const settings = await this.getSettingsCached();
    this.applyCacheSettings(settings);
    // 缓存命中直接整段返回（不发请求、不产增量）
    const cached = this.cacheEnabled ? await this.cache.get(targetLang, text, this.cacheVariant) : undefined;
    if (cached !== undefined) return cached;

    const limit = Math.max(1, settings.api.maxConcurrency || 3);
    const interval = Math.max(50, settings.api.minRequestIntervalMs ?? 500);
    this.minRequestIntervalMs = interval;
    this.configureChannels(1000 / interval, Math.min(limit, 16));

    let emitted = false;
    const emit = (delta: string): void => {
      if (!delta) return;
      emitted = true;
      onDelta(delta);
    };
    const attempt = async (api: ApiConfig): Promise<string> => {
      const system = withCustomPrompt(systemPrompt(targetLang), settings.api.customSystemPrompt);
      const messages: ChatMessage[] = [
        { role: "system", content: system },
        { role: "user", content: text },
      ];
      let lastError: unknown;
      // 至多一次退避重试，且仅「尚未产出增量」时——增量已出再重试会从零重发造成重复文本
      for (let round = 0; round < 2; round++) {
        if (signal?.aborted) throw new TranslationCancelledError();
        try {
          return await this.runConcurrent(limit, () =>
            this.requestStream(
              api,
              messages,
              targetLang,
              emit,
              signal,
              settings.api.freeEndpoint,
              settings.api.freeBackupEndpoint
            )
          );
        } catch (err) {
          lastError = err;
          if (emitted || !isRetryable(err) || signal?.aborted) break;
          // 429 与整页翻译同样做队列级冷却（仅限当前通道），避免气泡重试继续冲击已限流的通道
          if (err instanceof ApiError && err.code === "rate_limit") {
            this.pauseRateLimit(
              api,
              Math.min(err.retryAfterMs ?? RATE_LIMIT_BASE_PAUSE_MS, MAX_RETRY_AFTER_MS)
            );
          }
          await sleep(backoffDelayMs(0));
        }
      }
      throw lastError;
    };

    try {
      return await this.finishStream(targetLang, text, await attempt(settings.api));
    } catch (err) {
      // 会话中止（气泡关闭）：归一化为取消错误，上两层不得当作普通失败处理
      if (signal?.aborted || (err instanceof Error && err.message === "cancelled")) {
        throw new TranslationCancelledError();
      }
      // 与 callApi 同一套降级顺序：免费通道互切 → 备用 API；
      // 两者都仅在「尚未产出增量」时值得切（已出增量的失败只能上抛，重试会重复文本）
      if (isRetryable(err) && !emitted) {
        const sibling = freeSiblingApi(settings);
        if (sibling) {
          try {
            return await this.finishStream(targetLang, text, await attempt(sibling));
          } catch (siblingErr) {
            if (signal?.aborted) throw new TranslationCancelledError();
            if (settings.backupApi && isRetryable(siblingErr) && !emitted) {
              try {
                return await this.finishStream(targetLang, text, await attempt(settings.backupApi));
              } catch (backupErr) {
                if (signal?.aborted) throw new TranslationCancelledError();
                throw withErrorSource(backupErr, "backup");
              }
            }
            throw withErrorSource(siblingErr, "main");
          }
        }
        if (settings.backupApi) {
          try {
            return await this.finishStream(targetLang, text, await attempt(settings.backupApi));
          } catch (backupErr) {
            if (signal?.aborted) throw new TranslationCancelledError();
            throw withErrorSource(backupErr, "backup");
          }
        }
      }
      throw withErrorSource(err, "main");
    }
  }

  /** 流收尾：免译哨兵映射为原文（不重试不报错），并写缓存（与整页翻译同口径） */
  private async finishStream(targetLang: string, text: string, raw: string): Promise<string> {
    const finalText = mapNoTranslationNeeded(text, raw);
    await this.storeCache(targetLang, text, finalText);
    return finalText;
  }

  /** 单次流式 API 调用：与 request 同一套启动限速 / 超时缩放，增量回调 emit；
   *  免费通道端点参数与 callApi 同源透传（免费通道在 Port 上一次性整段返回） */
  private async requestStream(
    api: ApiConfig,
    messages: ChatMessage[],
    targetLang: string,
    emit: (delta: string) => void,
    signal?: AbortSignal,
    freeEndpoint?: string,
    freeBackupEndpoint?: string
  ): Promise<string> {
    await this.acquireStartSlot(api);
    const provider = createProvider(api);
    const chars = messages.reduce((n, m) => n + m.content.length, 0);
    const result = await provider.chat(messages, {
      baseUrl: api.baseUrl,
      apiKey: api.apiKey,
      model: api.model,
      temperature: api.temperature,
      timeoutMs: scaleTimeoutMs(api.timeoutMs, chars),
      targetLang,
      signal,
      freeEndpoint,
      freeBackupEndpoint,
      stream: { onDelta: emit },
    });
    return result.text;
  }

  /** 清空译文缓存（设置页入口） */
  async clearCache(): Promise<void> {
    await Promise.all([this.cache.clear(), this.summaryCache.clear()]);
  }

  /** 清理过期/超额缓存条目（chrome.alarms 每日触发；设置页可手动触发）。返回删除条数 */
  async cleanupCache(): Promise<number> {
    this.applyCacheSettings(await this.getSettingsCached());
    const [removed, removedSummaries] = await Promise.all([
      this.cache.cleanupExpired(),
      this.summaryCache.cleanupExpired(),
    ]);
    return removed + removedSummaries;
  }

  /** 磁盘层缓存条目数（设置页「缓存管理」展示；含译文 + 页面摘要） */
  async cacheStats(): Promise<number> {
    const [count, summaryCount] = await Promise.all([
      this.cache.diskCount(),
      this.summaryCache.diskCount(),
    ]);
    return count + summaryCount;
  }

  /** 返回一批文本中命中缓存的条数（用于内容侧决定整页直译还是视口懒翻译） */
  async checkCache(targetLang: string, texts: string[]): Promise<number> {
    this.applyCacheSettings(await this.getSettingsCached());
    if (!this.cacheEnabled) return 0;
    // 并发查缓存：Promise.all 代替串行 await
    const checks = await Promise.all(
      texts.map((t) => this.cache.get(targetLang, t, this.cacheVariant))
    );
    return checks.filter((v) => v !== undefined).length;
  }

  /**
   * LLM 页面摘要（整页翻译期间由 content 异步请求，不阻塞翻译批次）：
   * 缓存命中直接返回；未命中走与翻译同一套启动限速/并发限制的 LLM 请求生成 2-3 句摘要并落盘。
   * best-effort：开关关闭 / 免费通道 / 空正文 / 请求失败 一律返回 ""，
   * content 侧保持「标题/描述/正文截断」的原始上下文，不受影响。
   */
  async generatePageSummary(title: string, content: string, signal?: AbortSignal): Promise<string> {
    const settings = await this.getSettingsCached();
    this.applyCacheSettings(settings);
    if (!settings.translate.summaryEnabled || signal?.aborted) return "";
    // 免费通道（googlefree/microsoft）是纯翻译端点，无法执行摘要指令：只支持 LLM 通道
    if (settings.api.format === "googlefree" || settings.api.format === "microsoft") return "";
    const t = title.trim();
    const c = content.trim();
    if (!c) return "";
    const cached = this.cacheEnabled
      ? await this.summaryCache.get(t, c, this.summaryVariant)
      : undefined;
    if (cached !== undefined) return cached;

    // 跨标签页去重：同一页面的并发摘要请求共享同一次生成
    const key = `${this.summaryVariant}|${fnv1aHex(`${t}\u0000${c}`)}`;
    const inflight = this.summaryInflight.get(key);
    if (inflight) return inflight;
    const promise = this.generateSummary(settings, t, c, signal);
    this.summaryInflight.set(key, promise);
    try {
      return await promise;
    } finally {
      // 仅当条目仍指向本次执行时清除（并发覆盖场景不能误删后发起的请求）
      if (this.summaryInflight.get(key) === promise) this.summaryInflight.delete(key);
    }
  }

  /** 摘要生成执行体：与翻译共用限速/并发/重试设施；失败静默返回 ""，不缓存失败结果 */
  private async generateSummary(
    settings: Settings,
    title: string,
    content: string,
    signal?: AbortSignal
  ): Promise<string> {
    const limit = Math.max(1, settings.api.maxConcurrency || 3);
    const interval = Math.max(50, settings.api.minRequestIntervalMs ?? 500);
    this.minRequestIntervalMs = interval;
    this.configureChannels(1000 / interval, Math.min(limit, 16));
    const messages: ChatMessage[] = [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: `标题：${title || "（无标题）"}\n\n正文：\n${content}` },
    ];
    const api = settings.api;
    try {
      // 摘要是 best-effort 增强：至多一次重试，避免坏端点上每页都白烧 4 次请求
      const raw = await this.runConcurrent(limit, () =>
        withRetry(
          () =>
            this.request(api, messages, {
              batchMode: "lines",
              batchSeparator: BATCH_SEPARATOR,
              batchSize: 1,
              freeEndpoint: api.freeEndpoint,
              freeBackupEndpoint: api.freeBackupEndpoint,
              signal,
            }),
          1,
          (pauseMs) => this.pauseRateLimit(api, pauseMs)
        )
      );
      if (signal?.aborted) return "";
      const summary = raw.trim().slice(0, MAX_SUMMARY_CHARS);
      if (!summary) return "";
      if (this.cacheEnabled) {
        await this.summaryCache.set(title, content, summary, this.summaryVariant);
      }
      return summary;
    } catch {
      return "";
    }
  }

  /** 应用缓存设置（开关 / 内存条目上限 / 过期天数 / 变体）：每次请求前刷新，设置页改动即时生效 */
  private applyCacheSettings(settings: Settings): void {
    this.cacheEnabled = settings.cache.enabled;
    this.cache.maxEntries = Math.max(1, settings.cache.maxEntries || 5000);
    this.cache.ttlDays = Math.max(0, settings.cache.ttlDays ?? 7);
    this.cacheVariant = fnv1aHex(
      [settings.api.format, settings.api.model, settings.api.customSystemPrompt ?? ""].join("|")
    );
    this.summaryCache.maxEntries = this.cache.maxEntries;
    this.summaryCache.ttlDays = this.cache.ttlDays;
    this.summaryVariant = fnv1aHex([settings.api.format, settings.api.model].join("|"));
  }

  /** 带缓存的 getSettings：避免每次翻译请求都读 chrome.storage + 解密 API Key。
   *  设置页保存后通过 chrome.storage.onChanged 事件自动刷新缓存。 */
  private async getSettingsCached(): Promise<Settings> {
    if (this.cachedSettings) return this.cachedSettings;
    const settings = await getSettings();
    this.cachedSettings = settings;
    // 首次调用时注册 storage 变更监听（只注册一次）
    if (!this.storageListenerRegistered) {
      this.storageListenerRegistered = true;
      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === "local" && changes.settings) {
            this.cachedSettings = null; // 失效，下次 getSettingsCached 重新读
          }
        });
      } catch {
        // 某些环境可能没有 onChanged，忽略
      }
    }
    return settings;
  }
  private storageListenerRegistered = false;

  /** 写缓存：关闭缓存时不写；磁盘写入失败（如存储配额超限）不影响翻译结果 */
  private async storeCache(
    targetLang: string,
    text: string,
    translation: string
  ): Promise<void> {
    if (!this.cacheEnabled) return;
    await this.cache.set(targetLang, text, translation, this.cacheVariant);
  }

  /** 单次 API 调用：主 API 重试 → 可重试错误时切换备用 API。
   *  协议按「通道」决定：googlefree 固定哨兵（不支持逐行指令前缀），第三方 LLM 按配置。 */
  private async callApi(
    settings: Settings,
    texts: string[],
    targetLang: string,
    opts?: {
      batch?: boolean;
      batchMode?: BatchMode;
      context?: TranslationContext;
      signal?: AbortSignal;
    }
  ): Promise<string> {
    const rawContext = opts?.context
      ? `\n\n页面上下文（仅用于理解语境，不要翻译或复述这段上下文）：\n标题：${opts.context.title ?? ""}\n描述：${opts.context.description ?? ""}${opts.context.summary ? `\n文章摘要：${opts.context.summary}` : ""}\n正文摘要：${opts.context.content ?? ""}`
      : "";
    const contextText = withSourceLangContext(rawContext, opts?.context?.sourceLang ?? "");
    const chatOpts = (mode: BatchMode) => ({
      batchMode: mode,
      batchSeparator: BATCH_SEPARATOR,
      batchSize: texts.length,
      freeEndpoint: settings.api.freeEndpoint,
      freeBackupEndpoint: settings.api.freeBackupEndpoint,
      // 免费通道显式拿目标语言，避免从中文提示词正则反解（P3-5）；signal 供会话中止打断在途 fetch
      targetLang,
      // 源语言（html lang / 启发式 / 用户强制）：免费通道据此设 sl/from，LLM 通道走提示词语境
      sourceLang: opts?.context?.sourceLang,
      signal: opts?.signal,
    });

    const attempt = (api: ApiConfig): Promise<string> => {
      const isBatch = (opts?.batch ?? false) && texts.length > 1;
      // 免费通道 provider（googlefree/microsoft）无法执行逐行协议（会把逐行指令前缀当作
      // 待译段发给免费端点）：其内部固定使用安全哨兵协议，与 ApiConfig.batchMode 的文档约定
      // 一致；第三方 LLM 按配置（默认逐行）。
      const isFreeChannel = api.format === "googlefree" || api.format === "microsoft";
      const mode: BatchMode = isFreeChannel ? "separator" : (opts?.batchMode ?? "lines");
      // 免译哨兵冲突防护（与 ===IT_SEP=== 同思路）：原文本身含 {{NO_TRANSLATION_NEEDED}} 字样时，
      // 模型可能把它当普通文本回显造成段内容歧义 → 本批不注入免译指令
      const noTranslationSafe = !texts.some((t) => t.includes(NO_TRANSLATION_SENTINEL));
      let system: string;
      let user: string;
      if (!isBatch) {
        system = withCustomPrompt(systemPrompt(targetLang), settings.api.customSystemPrompt);
        user = texts[0];
      } else if (mode === "separator") {
        system = withCustomPrompt(sentinelSystemPrompt(targetLang), settings.api.customSystemPrompt);
        user = texts.join(`\n${BATCH_SEPARATOR}\n`);
      } else {
        // 旧版逐行协议：system/user 主体与历史版本一致，第三方站点兼容性最好
        system = withCustomPrompt(systemPrompt(targetLang), settings.api.customSystemPrompt);
        user = linesBatchUserContent(texts);
      }
      // 免译指令只追加给 LLM 通道的批量协议（免费通道端点不解析 system 指令）
      if (isBatch && !isFreeChannel && noTranslationSafe) {
        system += noTranslationRule();
      }
      const messages: ChatMessage[] = [
        { role: "system", content: system + contextText },
        { role: "user", content: user },
      ];
      return withRetry(
        () => this.request(api, messages, chatOpts(mode)),
        MAX_RETRIES,
        (pauseMs) => this.pauseRateLimit(api, pauseMs)
      );
    };

    try {
      return await attempt(settings.api);
    } catch (err) {
      // 免费通道自动互切：主通道是 googlefree/microsoft 之一且未配置备用 API 时，
      // 可重试失败（限流/网络/服务端）自动切到另一个免费通道再试一次
      const sibling = freeSiblingApi(settings);
      if (sibling && isRetryable(err)) {
        try {
          return await attempt(sibling);
        } catch (siblingErr) {
          // 互切也失败：有备用 API 则继续走备用，否则上抛并标注来源
          if (settings.backupApi && isRetryable(siblingErr)) {
            try {
              return await attempt(settings.backupApi);
            } catch (backupErr) {
              throw withErrorSource(backupErr, "backup");
            }
          }
          throw withErrorSource(siblingErr, "main");
        }
      }
      if (settings.backupApi && isRetryable(err)) {
        try {
          return await attempt(settings.backupApi);
        } catch (backupErr) {
          // 主备都失败：上抛备用通道的错误并标注来源，工具条才能区分是哪一路出的问题
          throw withErrorSource(backupErr, "backup");
        }
      }
      // 仅主 API 失败（不可重试或未配置备用）：标注「主 API」，避免误报为备用/免费通道错误
      throw withErrorSource(err, "main");
    }
  }

  private async request(api: ApiConfig, messages: ChatMessage[], chatOpts: BatchChatOptions): Promise<string> {
    // 启动限速：令牌桶把"请求启动速率"钳制住——允许短突发（≤并发数），
    // 但长期平均间隔不小于 REQUEST_MIN_INTERVAL_MS，防止瞬时高并发触发服务商限流/封号。
    await this.acquireStartSlot(api);
    const provider = createProvider(api);
    // 批量请求的生成时间随字符数增长：超时按字符数缩放（封顶 120s），
    // 避免「还在正常生成」的大批被误判超时重试、反而放大请求量
    const chars = messages.reduce((n, m) => n + m.content.length, 0);
    const result = await provider.chat(messages, {
      baseUrl: api.baseUrl,
      apiKey: api.apiKey,
      model: api.model,
      temperature: api.temperature,
      timeoutMs: scaleTimeoutMs(api.timeoutMs, chars),
      ...chatOpts,
    });
    return result.text;
  }

  /** 通道标识：同格式同端点视为同一 provider（主备即使格式相同、端点不同也互相独立） */
  private static channelKey(api: ApiConfig): string {
    return `${api.format}|${api.baseUrl}`;
  }

  private channelOf(api: ApiConfig): ChannelLimiter {
    const key = TranslateService.channelKey(api);
    let ch = this.channels.get(key);
    if (!ch) {
      ch = { bucket: new TokenBucket(this.channelRate, this.channelCapacity), pausedUntil: 0 };
      this.channels.set(key, ch);
    }
    return ch;
  }

  /** 设置刷新（请求间隔/并发变化）时同步到全部已建通道；新通道按新值创建 */
  private configureChannels(rate: number, capacity: number): void {
    this.channelRate = rate;
    this.channelCapacity = capacity;
    for (const ch of this.channels.values()) ch.bucket.configure(rate, capacity);
  }

  /** 429 队列级冷却（仅限触发限流的通道）：暂停窗口内不放行该通道新请求，
   *  窗口后容量钳到 1（后探针），避免恢复瞬间 burst 一堆请求冲击仍受限的 provider
   *  （借鉴 read-frog）。其余通道（主/备/免费互切目标）不受牵连。 */
  private pauseRateLimit(api: ApiConfig, pauseMs: number): void {
    const ch = this.channelOf(api);
    ch.pausedUntil = Math.max(ch.pausedUntil, Date.now() + pauseMs);
    ch.bucket.configure(this.channelRate, 1);
  }

  /** 令牌桶取令牌（按通道）：取到返回；取不到睡到凑够一个令牌再取。 */
  private async acquireStartSlot(api: ApiConfig): Promise<void> {
    const ch = this.channelOf(api);
    for (;;) {
      const pauseWait = ch.pausedUntil - Date.now();
      if (pauseWait > 0) await sleep(pauseWait);
      const wait = ch.bucket.tryAcquire();
      if (wait === 0) return;
      await sleep(wait);
    }
  }

  private async runConcurrent<T>(limit: number, task: () => Promise<T>): Promise<T> {
    if (this.active >= limit) {
      await new Promise<void>((resolve) => this.pending.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      // 用指针索引代替 shift()（shift 是 O(n)，指针是 O(1)）
      const resolver = this.pending[this.pendingHead];
      if (resolver) {
        this.pending[this.pendingHead++] = undefined as unknown as () => void;
        resolver();
      }
      // 队列消费完后重置，避免数组无限增长
      if (this.pendingHead > 0 && this.pendingHead >= this.pending.length) {
        this.pending = [];
        this.pendingHead = 0;
      }
    }
  }
}

/**
 * 拆分批量译文：优先按哨兵 ${BATCH_SEPARATOR} 分段（鲁棒）；哨兵缺失时退回按行匹配。
 * 都不匹配返回 null，走逐段并发降级。（导出供单元测试）
 */export function splitBatch(batch: string, expected: number): string[] | null {
  // ① 哨兵分段：模型按 ===IT_SEP=== 分隔输出，段数应与输入一致
  if (batch.includes(BATCH_SEPARATOR)) {
    const parts = batch
      .split(BATCH_SEPARATOR)
      .map((s) => stripIndex(s.trim()))
      .filter((s) => s !== "");
    if (parts.length === expected) return parts;
    // 哨兵段数不符：可能是模型在译文里误带哨兵，放弃哨兵路线继续走行匹配兜底
  }

  // ② 兜底：按行匹配（兼容旧行为 / 模型忽略哨兵时）。先剔除哨兵行，避免分隔符漏进译文
  const lines = batch
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s !== "" && s !== BATCH_SEPARATOR);
  const numbered = lines.map((l) => l.match(/^\d+[.、．:：]\s*(.+)$/)?.[1]?.trim());
  // 若全部带编号，用剥离后的内容
  if (numbered.every((n) => n !== undefined && n !== "")) {
    if (numbered.length === expected) return numbered as string[];
  }
  if (lines.length === expected) {
    // 部分行带编号（模型只给部分行编号）：逐行剥离，避免 "1." 残留进译文
    if (numbered.some((n) => n)) return lines.map((l, i) => numbered[i] || l);
    return lines;
  }
  return null;
}

/** 剥掉段首可能残留的编号（"1. 译文" → "译文"） */
function stripIndex(s: string): string {
  return s.replace(/^\d+[.、．:：]\s*/, "");
}

/** 免译哨兵映射：段输出「严格等于」{{NO_TRANSLATION_NEEDED}}（忽略首尾空白）→ 返回原文。
 *  免费通道不注入该指令，但解析同样兜底映射（模型自发回该标记时保持原文，不重试不报错）。 */
export function mapNoTranslationNeeded(source: string, translated: string): string {
  return translated.trim() === NO_TRANSLATION_SENTINEL ? source : translated.trim();
}