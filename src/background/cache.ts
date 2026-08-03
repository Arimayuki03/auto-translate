const CACHE_PREFIX = "it-cache:";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 译文缓存：内存（快速层）+ chrome.storage.local（磁盘持久层）。
 * 磁盘层跨会话复用，刷新/重启浏览器后仍能命中，节省 API token。
 */
export class TranslationCache {
  private memory = new Map<string, string>();

  constructor(private maxEntries = 5000) {}

  async get(targetLang: string, text: string): Promise<string | undefined> {
    const key = await this.cacheKey(targetLang, text);
    if (this.memory.has(key)) return this.memory.get(key);
    const stored = await chrome.storage.local.get(key);
    const value = stored[key];
    if (typeof value === "string") {
      this.memory.set(key, value);
      return value;
    }
    return undefined;
  }

  async set(targetLang: string, text: string, translation: string): Promise<void> {
    const key = await this.cacheKey(targetLang, text);
    if (this.memory.size >= this.maxEntries && !this.memory.has(key)) {
      // 软上限：超出时淘汰最老一条（Map 迭代序 = 插入序）
      const oldest = this.memory.keys().next().value as string | undefined;
      if (oldest) this.memory.delete(oldest);
    }
    this.memory.set(key, translation);
    await chrome.storage.local.set({ [key]: translation });
  }

  async clear(): Promise<void> {
    this.memory.clear();
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
    if (keys.length > 0) {
      await chrome.storage.local.remove(keys);
    }
  }

  private async cacheKey(targetLang: string, text: string): Promise<string> {
    return CACHE_PREFIX + (await sha256Hex(`${targetLang}|${text}`));
  }
}
