const CACHE_PREFIX = "it-cache:";

/** FNV-1a 同步哈希：比 SHA-256 快两个数量级，无异步开销，适合高频缓存键。
 *  32 位哈希在条目量大时有碰撞可能——因此值里同时保存原文（src），读取时校验：
 *  碰撞只会导致一次缓存未命中（重译并覆盖），绝不会把 A 文本的译文当 B 的返回。 */
function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 缓存条目：val 为译文，src 为原文（用于哈希碰撞校验）。
 *  历史版本落盘的是纯字符串译文，读取时按原样兼容（无法校验，随时间自然淘汰）。 */
interface CacheEntry {
  src: string;
  val: string;
}

/** 把存储层读出的值解析为可信译文：新结构校验原文，旧字符串直接兼容 */
function parseEntry(value: unknown, text: string): string | undefined {
  if (typeof value === "string") return value; // 历史格式
  if (value && typeof value === "object" && "val" in value) {
    const entry = value as Partial<CacheEntry>;
    if (entry.src === text && typeof entry.val === "string") return entry.val;
    return undefined; // 哈希碰撞：另一条文本的译文，视为未命中
  }
  return undefined;
}

/**
 * 译文缓存：内存（快速层）+ chrome.storage.local（磁盘持久层）。
 *  磁盘层跨会话复用，刷新/重启浏览器后仍能命中，节省 API token。
 */
export class TranslationCache {
  private memory = new Map<string, CacheEntry>();
  /** 磁盘层已写入的 key 列表（clear 时直接 remove，避免 get(null) 读整个 storage） */
  private diskKeys: string[] = [];

  /** 内存层条目软上限（由 TranslateService 按设置页 cache.maxEntries 刷新） */
  maxEntries: number;

  constructor(maxEntries = 5000) {
    this.maxEntries = maxEntries;
  }

  async get(targetLang: string, text: string): Promise<string | undefined> {
    const key = this.cacheKey(targetLang, text);
    const hit = this.memory.get(key);
    if (hit) {
      // 内存层同样校验：哈希碰撞时后写的条目覆盖先写的，先写的必须判未命中
      return hit.src === text ? hit.val : undefined;
    }
    const stored = await chrome.storage.local.get(key);
    const val = parseEntry(stored[key], text);
    if (val !== undefined) {
      this.memory.set(key, { src: text, val });
      return val;
    }
    return undefined;
  }

  async set(targetLang: string, text: string, translation: string): Promise<void> {
    if (!translation.trim()) return; // 空译文视为无效结果，不缓存（避免永久命中空串）
    const key = this.cacheKey(targetLang, text);
    const entry: CacheEntry = { src: text, val: translation };
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

  private cacheKey(targetLang: string, text: string): string {
    return CACHE_PREFIX + fnv1aHex(`${targetLang}|${text}`);
  }
}
