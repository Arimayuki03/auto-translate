/**
 * 回归测试：缓存设置（cache.enabled）必须真正生效。
 * 此前 TranslateService 硬编码使用缓存，设置里的开关被完全忽略。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TranslationCache } from "../src/background/cache";
import { TranslateService } from "../src/background/translate";

/** mock chrome.storage：settings 按 cacheEnabled 返回；缓存键返回带时间戳的新结构条目 */
function mockChrome(cacheEnabled: boolean, cachedValue?: string): void {
  const getMock = vi.fn(async (key: string) => {
    if (key === "settings") {
      return {
        settings: {
          version: 4,
          // 有效的主 API 配置：缓存关闭时必须真正发起请求
          api: {
            format: "openai",
            baseUrl: "https://example.test/v1",
            apiKey: "sk-test",
            model: "m",
            temperature: 0.3,
            timeoutMs: 60000,
            maxConcurrency: 3,
          },
          cache: { enabled: cacheEnabled, maxEntries: 100 },
        },
      };
    }
    if (typeof key === "string" && key.startsWith("it-cache:")) {
      return cachedValue !== undefined
        ? { [key]: { src: "hello", val: cachedValue, ts: Date.now() } }
        : {};
    }
    return {};
  });
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: getMock,
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    },
  } as unknown as typeof chrome;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("cache.enabled 设置生效", () => {
  it("缓存关闭时 checkCache 直接返回 0（不读磁盘缓存）", async () => {
    mockChrome(false, "已缓存的译文");
    const svc = new TranslateService();
    expect(await svc.checkCache("zh-CN", ["hello"])).toBe(0);
  });

  it("缓存开启时 checkCache 正常统计命中数", async () => {
    mockChrome(true, "已缓存的译文");
    const svc = new TranslateService();
    expect(await svc.checkCache("zh-CN", ["hello"])).toBe(1);
  });

  it("缓存关闭时 translate 不复用磁盘缓存（走 API 而非直接返回缓存值）", async () => {
    mockChrome(false, "已缓存的译文");
    // 拦截 API 请求：缓存若生效就不会走到 fetch
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "API 新译文" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const svc = new TranslateService();
    const results = await svc.translate(["hello"], "zh-CN");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results[0]).toBe("API 新译文");
    vi.unstubAllGlobals();
  });
});

describe("缓存条目校验（F-4：哈希碰撞不返回错误译文）", () => {
  /** 内存版 chrome.storage：可检查/改写落盘条目 */
  function mockStorageMemory(): Map<string, unknown> {
    const memory = new Map<string, unknown>();
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) =>
            memory.has(key) ? { [key]: memory.get(key) } : {}
          ),
          set: vi.fn(async (items: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(items)) memory.set(k, v);
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            const list = Array.isArray(keys) ? keys : [keys];
            for (const k of list) memory.delete(k);
          }),
        },
      },
    } as unknown as typeof chrome;
    return memory;
  }

  function firstCacheKey(memory: Map<string, unknown>): string {
    const key = [...memory.keys()].find((k) => k.startsWith("it-cache:"));
    if (!key) throw new Error("没有缓存键");
    return key;
  }

  it("新条目写入 {src,val,ts}：内存层失效后跨实例读取仍命中", async () => {
    const memory = mockStorageMemory();
    const cache = new TranslationCache();
    await cache.set("zh-CN", "hello", "你好");
    expect(memory.get(firstCacheKey(memory))).toMatchObject({ src: "hello", val: "你好" });
    expect((memory.get(firstCacheKey(memory)) as { ts: number }).ts).toBeTypeOf("number");
    const fresh = new TranslationCache(); // 内存层为空 → 走磁盘层解析
    expect(await fresh.get("zh-CN", "hello")).toBe("你好");
  });

  it("哈希碰撞（同键不同原文）→ 视为未命中，绝不返回另一条文本的译文", async () => {
    const memory = mockStorageMemory();
    const cache = new TranslationCache();
    await cache.set("zh-CN", "hello", "你好");
    memory.set(firstCacheKey(memory), { src: "-other-text-", val: "错误译文" }); // 模拟碰撞覆盖
    const fresh = new TranslationCache();
    expect(await fresh.get("zh-CN", "hello")).toBeUndefined();
  });

  it("历史纯字符串条目视为未命中（无 src 校验/无 ts，重译后以新结构落盘）", async () => {
    const memory = mockStorageMemory();
    const cache = new TranslationCache();
    await cache.set("zh-CN", "hello", "旧格式译文");
    memory.set(firstCacheKey(memory), "旧格式译文"); // 降级为历史格式
    const fresh = new TranslationCache();
    expect(await fresh.get("zh-CN", "hello")).toBeUndefined();
  });

  it("空译文不写入缓存（避免永久命中空串）", async () => {
    const memory = mockStorageMemory();
    const cache = new TranslationCache();
    await cache.set("zh-CN", "hello", "   ");
    expect(await cache.get("zh-CN", "hello")).toBeUndefined();
    expect([...memory.keys()].filter((k) => k.startsWith("it-cache:"))).toHaveLength(0);
  });
});

describe("缓存 TTL 与清理", () => {
  /** 内存版 chrome.storage：支持 get(null) 全量读取（cleanupExpired / diskCount 依赖） */
  function mockStorageFull(): Map<string, unknown> {
    const memory = new Map<string, unknown>();
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string | null) => {
            if (key === null) return Object.fromEntries(memory);
            return memory.has(key) ? { [key]: memory.get(key) } : {};
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(items)) memory.set(k, v);
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            const list = Array.isArray(keys) ? keys : [keys];
            for (const k of list) memory.delete(k);
          }),
        },
      },
    } as unknown as typeof chrome;
    return memory;
  }

  function cacheKeys(memory: Map<string, unknown>): string[] {
    return [...memory.keys()].filter((k) => k.startsWith("it-cache:"));
  }

  function ageEntry(memory: Map<string, unknown>, key: string, daysAgo: number): void {
    const entry = memory.get(key) as { src: string; val: string; ts: number };
    memory.set(key, { ...entry, ts: Date.now() - daysAgo * 24 * 60 * 60 * 1000 });
  }

  it("过期条目读取为未命中（默认 7 天 TTL）", async () => {
    const memory = mockStorageFull();
    const cache = new TranslationCache();
    await cache.set("zh-CN", "hello", "你好");
    ageEntry(memory, cacheKeys(memory)[0]!, 8); // 写入时间改到 8 天前
    const fresh = new TranslationCache(); // 新实例绕过内存层
    expect(await fresh.get("zh-CN", "hello")).toBeUndefined();
  });

  it("ttlDays = 0 表示永不过期", async () => {
    const memory = mockStorageFull();
    const cache = new TranslationCache();
    cache.ttlDays = 0;
    await cache.set("zh-CN", "hello", "你好");
    ageEntry(memory, cacheKeys(memory)[0]!, 365);
    const fresh = new TranslationCache();
    fresh.ttlDays = 0;
    expect(await fresh.get("zh-CN", "hello")).toBe("你好");
  });

  it("cleanupExpired 移除过期与历史格式条目，返回删除数", async () => {
    const memory = mockStorageFull();
    const cache = new TranslationCache();
    await cache.set("zh-CN", "fresh", "新"); // 保留
    const keys = cacheKeys(memory);
    ageEntry(memory, keys[0]!, 10); // 新条目改成 10 天前 → 过期
    memory.set("it-cache:legacy", "历史字符串条目"); // 历史格式 → 无 ts，过期
    memory.set("it-cache:broken", { nope: true }); // 结构损坏 → 清理
    expect(await cache.cleanupExpired()).toBe(3);
    expect(cacheKeys(memory)).toHaveLength(0);
  });

  it("cleanupExpired 超出 maxEntries 时按写入时间保留最新 N 条", async () => {
    const memory = mockStorageFull();
    const cache = new TranslationCache();
    cache.maxEntries = 2;
    await cache.set("zh-CN", "a", "1");
    await cache.set("zh-CN", "b", "2");
    await cache.set("zh-CN", "c", "3");
    const keys = cacheKeys(memory);
    // a 最老（10 天前），b 次之（5 天前），c 最新 → 保留 b/c，淘汰 a
    ageEntry(memory, keys[0]!, 10);
    ageEntry(memory, keys[1]!, 5);
    expect(await cache.cleanupExpired()).toBe(1);
    const values = new Set(
      cacheKeys(memory).map((k) => (memory.get(k) as { val: string }).val)
    );
    expect(values).toEqual(new Set(["2", "3"]));
  });

  it("diskCount 统计缓存条目数（不含其他键）", async () => {
    const memory = mockStorageFull();
    const cache = new TranslationCache();
    await cache.set("zh-CN", "hello", "你好");
    memory.set("settings", { version: 4 });
    expect(await cache.diskCount()).toBe(1);
  });
});
