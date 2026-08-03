import type { ApiConfig, Settings } from "../shared/types";
import { getSettings } from "../shared/storage";
import { TranslationCache } from "./cache";
import { ApiError } from "./providers/http";
import { createProvider } from "./providers";
import type { ChatMessage } from "./providers/types";

const MAX_RETRIES = 3;

function systemPrompt(targetLang: string): string {
  return `你是专业翻译引擎。将用户输入翻译为${targetLang}，只输出译文，不要解释、不要添加任何额外内容。`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err: unknown): boolean {
  return err instanceof ApiError && err.retryable;
}

async function withRetry<T>(task: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === retries) {
        throw err;
      }
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

export class TranslateService {
  private cache = new TranslationCache();
  private active = 0;
  private pending: Array<() => void> = [];

  /** 批量翻译：缓存命中 + 批量合并 + 并发限制 + 主备切换 */
  async translate(texts: string[], targetLang: string): Promise<string[]> {
    const settings = await getSettings();
    const limit = Math.max(1, settings.api.maxConcurrency || 3);
    const results: string[] = new Array(texts.length);
    const toFetch: number[] = [];

    for (let i = 0; i < texts.length; i++) {
      const cached = await this.cache.get(targetLang, texts[i]);
      if (cached !== undefined) {
        results[i] = cached;
      } else {
        toFetch.push(i);
      }
    }
    if (toFetch.length === 0) return results;

    const joined = toFetch.map((i) => texts[i]);
    if (joined.length > 1) {
      try {
        const batch = await this.runConcurrent(limit, () => this.callApi(settings, joined, targetLang));
        const parts = splitBatch(batch, joined.length);
        if (parts) {
          for (let k = 0; k < joined.length; k++) {
            const t = parts[k];
            results[toFetch[k]] = t;
            await this.cache.set(targetLang, joined[k], t);
          }
          return results;
        }
      } catch {
        // 批量失败，降级逐段重试
      }
    }

    // 逐段降级：并发受限（一次最多 limit 个请求在途），显著快于串行
    await Promise.all(
      toFetch.map((idx) =>
        this.runConcurrent(limit, () => this.callApi(settings, [texts[idx]], targetLang))
          .then(async (text) => {
            const t = text.trim();
            results[idx] = t;
            await this.cache.set(targetLang, texts[idx], t);
          })
          .catch(() => {
            results[idx] = "";
          })
      )
    );
    return results;
  }

  /** 单次 API 调用：主 API 重试 → 可重试错误时切换备用 API */
  private async callApi(settings: Settings, texts: string[], targetLang: string): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(targetLang) },
      {
        role: "user",
        content:
          texts.length === 1
            ? texts[0]
            : `请逐行翻译以下内容，每行一个译文，保持顺序，不要编号，不要任何额外文字：\n${texts.join("\n")}`,
      },
    ];
    try {
      return await withRetry(() => this.request(settings.api, messages));
    } catch (err) {
      if (settings.backupApi && isRetryable(err)) {
        return await withRetry(() => this.request(settings.backupApi!, messages));
      }
      throw err;
    }
  }

  private async request(api: ApiConfig, messages: ChatMessage[]): Promise<string> {
    const provider = createProvider(api);
    const result = await provider.chat(messages, {
      baseUrl: api.baseUrl,
      apiKey: api.apiKey,
      model: api.model,
      temperature: api.temperature,
      timeoutMs: api.timeoutMs,
    });
    return result.text;
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
      this.pending.shift()?.();
    }
  }
}

/**
 * 拆分批量译文：先按行数匹配；模型加了编号时再按「数字. 译文」抽取。
 * 都不匹配返回 null，走逐段并发降级。
 */
function splitBatch(batch: string, expected: number): string[] | null {
  const lines = batch.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === expected) return lines;
  const numbered = lines
    .map((l) => l.match(/^\d+[.、．:：]\s*(.+)$/)?.[1]?.trim() ?? "")
    .filter(Boolean);
  if (numbered.length === expected) return numbered;
  return null;
}