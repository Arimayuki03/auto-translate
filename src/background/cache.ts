const CACHE_PREFIX = "it-cache:";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 会话级译文缓存（内存 + chrome.storage.session） */
export class TranslationCache {
  private memory = new Map<string, string>();

  async get(targetLang: string, text: string): Promise<string | undefined> {
    const key = await this.cacheKey(targetLang, text);
    if (this.memory.has(key)) return this.memory.get(key);
    const stored = await chrome.storage.session.get(key);
    const value = stored[key];
    if (typeof value === "string") {
      this.memory.set(key, value);
      return value;
    }
    return undefined;
  }

  async set(targetLang: string, text: string, translation: string): Promise<void> {
    const key = await this.cacheKey(targetLang, text);
    this.memory.set(key, translation);
    await chrome.storage.session.set({ [key]: translation });
  }

  async clear(): Promise<void> {
    this.memory.clear();
    const all = await chrome.storage.session.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
    if (keys.length > 0) {
      await chrome.storage.session.remove(keys);
    }
  }

  private async cacheKey(targetLang: string, text: string): Promise<string> {
    return CACHE_PREFIX + (await sha256Hex(`${targetLang}|${text}`));
  }
}