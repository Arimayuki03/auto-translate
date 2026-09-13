const CACHE_PREFIX = "it-cache:";

/** FNV-1a 同步哈希：比 SHA-256 快两个数量级，无异步开销，适合高频缓存键。
 *  32 位哈希在条目量大时有碰撞可能——因此值里同时保存原文（src），读取时校验：
 *  碰撞只会导致一次缓存未命中（重译并覆盖），绝不会把 A 文本的译文当 B 的返回。
 *  （导出供 background 请求去重键复用） */
export function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 缓存条目：val 为译文，src 为原文（用于哈希碰撞校验），ts 为写入时间戳（TTL 淘汰用）。
 *  历史版本落盘的是纯字符串译文（无 src/ts）：读取时视为未命中（重译后以新结构落盘），
 *  每日清理会将其移除。 */
interface CacheEntry {
  src: string;
  val: string;
  ts: number;
}

/** 把存储层读出的值解析为可信条目：新结构校验原文与时间戳，历史纯字符串视为未命中 */
function parseEntry(value: unknown, text: string): CacheEntry | undefined {
  if (typeof value === "string") return undefined; // 历史格式（无 src 校验、无 ts）：重译后落新结构
  if (value && typeof value === "object" && "val" in value) {
    const entry = value as Partial<CacheEntry>;
    if (entry.src === text && typeof entry.val === "string") {
      // 无 ts 的中间版本条目按 0 处理 → 立即过期（宁可重译，不留无界旧数据）
      return { src: text, val: entry.val, ts: typeof entry.ts === "number" ? entry.ts : 0 };
    }
    return undefined; // 哈希碰撞：另一条文本的译文，视为未命中
  }
  return undefined;
}

/** 清理用解析：不校验原文（清理时无从得知），只验结构与时间戳 */
function parseEntryForCleanup(value: unknown): CacheEntry | undefined {
  if (!value || typeof value !== "object" || !("val" in value)) return undefined;
  const e = value as Partial<CacheEntry>;
  if (typeof e.src !== "string" || typeof e.val !== "string") return undefined;
  return { src: e.src, val: e.val, ts: typeof e.ts === "number" ? e.ts : 0 };
}

/**
 * 译文缓存：内存（快速层）+ chrome.storage.local（磁盘持久层）。
 *  磁盘层跨会话复用，刷新/重启浏览器后仍能命中，节省 API token。
 *  条目带写入时间戳，按 ttlDays 过期（0 = 永不过期）；每日清理见 cleanupExpired。
 */
export class TranslationCache {
  private memory = new Map<string, CacheEntry>();
  /** 磁盘层已写入的 key 列表（clear 时直接 remove，避免 get(null) 读整个 storage） */
  private diskKeys: string[] = [];

  /** 内存层条目软上限（由 TranslateService 按设置页 cache.maxEntries 刷新） */
  maxEntries: number;
  /** 条目保留天数：过期即未命中；0 = 永不过期（TranslateService 按设置页 cache.ttlDays 刷新） */
  ttlDays: number;

  constructor(maxEntries = 5000) {
    this.maxEntries = maxEntries;
    this.ttlDays = 7;
  }

  private expired(ts: number): boolean {
    if (this.ttlDays <= 0) return false;
    return Date.now() - ts > this.ttlDays * 24 * 60 * 60 * 1000;
  }

  async get(targetLang: string, text: string): Promise<string | undefined> {
    const key = this.cacheKey(targetLang, text);
    const hit = this.memory.get(key);
    if (hit) {
      // 内存层同样校验：哈希碰撞时后写的条目覆盖先写的，先写的必须判未命中
      if (hit.src !== text || this.expired(hit.ts)) return undefined;
      return hit.val;
    }
    const stored = await chrome.storage.local.get(key);
    const entry = parseEntry(stored[key], text);
    if (entry && !this.expired(entry.ts)) {
      this.memory.set(key, entry);
      return entry.val;
    }
    return undefined;
  }

  async set(targetLang: string, text: string, translation: string): Promise<void> {
    if (!translation.trim()) return; // 空译文视为无效结果，不缓存（避免永久命中空串）
    const key = this.cacheKey(targetLang, text);
    const entry: CacheEntry = { src: text, val: translation, ts: Date.now() };
    if (this.memory.size >= this.maxEntries && !this.memory.has(key)) {
      // 软上限：超出时淘汰最老一条（Map 迭代序 = 插入序）
      const oldest = this.memory.keys().next().value as string | undefined;
      if (oldest) this.memory.delete(oldest);
    }
    this.memory.set(key, entry);
    // 磁盘层写入失败（如 chrome.storage 配额超限）不影响翻译主流程，仅丢失持久化
    await chrome.storage.local.set({ [key]: entry }).catch(() => undefined);
    this.diskKeys.push(key);
  }

  async clear(): Promise<void> {
    this.memory.clear();
    // 直接 remove 已记录的 key，避免 get(null) 把整个 storage.local 读入内存
    if (this.diskKeys.length > 0) {
      await chrome.storage.local.remove(this.diskKeys).catch(() => undefined);
      this.diskKeys = [];
    }
    // 兜底：扫描并清理可能遗漏的旧 key（上次 clear 前写入的）
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
    if (keys.length > 0) {
      await chrome.storage.local.remove(keys).catch(() => undefined);
    }
  }

  /**
   * 每日清理（chrome.alarms 触发，设置页可手动触发）：移除过期与损坏条目，
   * 再按 maxEntries 保留最新的 N 条，磁盘层不再只进不出（配额/碰撞风险随时间累积）。
   * 返回本次删除的条目数。
   */
  async cleanupExpired(): Promise<number> {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
    if (keys.length === 0) return 0;
    const valid: Array<{ key: string; ts: number }> = [];
    const toRemove: string[] = [];
    for (const key of keys) {
      const entry = parseEntryForCleanup(all[key]);
      if (!entry || this.expired(entry.ts)) {
        toRemove.push(key);
        continue;
      }
      valid.push({ key, ts: entry.ts });
    }
    // 超出上限：按写入时间保留最新 maxEntries 条
    if (valid.length > this.maxEntries) {
      valid.sort((a, b) => b.ts - a.ts);
      toRemove.push(...valid.slice(this.maxEntries).map((v) => v.key));
    }
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove).catch(() => undefined);
    }
    return toRemove.length;
  }

  /** 磁盘层当前条目数（设置页「缓存管理」展示用；只扫缓存前缀，不读值内容） */
  async diskCount(): Promise<number> {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX)).length;
  }

  private cacheKey(targetLang: string, text: string): string {
    return CACHE_PREFIX + fnv1aHex(`${targetLang}|${text}`);
  }
}
