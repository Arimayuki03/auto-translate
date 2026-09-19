/**
 * 批量译文缓存命中路径回归（cacheSettings.test.ts:65 只覆盖「关闭缓存 → 发请求」的
 * false 侧；「开启缓存」侧此前零覆盖）：
 *  1. 开启缓存 + 全部命中 → 零 provider 请求，直接按输入顺序返回缓存译文；
 *  2. 开启缓存 + 部分命中 → 只对未命中的文本发请求（整批合并为一次，非逐段重发），
 *     命中段绝不出现在请求体里，结果按下标回填；
 *  3. 对照侧：关闭缓存 + 磁盘有缓存 → 仍发请求（钉住 cacheEnabled 短路检查本身：
 *     若「把 enabled 检查删掉」，用例 1 依旧全绿，唯有此用例会红）。
 * 缓存条目用真实的 TranslationCache.set 写入（掺与 TranslateService 相同口径的变体，
 * 变体只掺 format/model/customSystemPrompt，见 translate.ts applyCacheSettings），
 * 仅 mock chrome.storage 与全局 fetch（拦截 provider 请求层，与 providerRequests.test.ts
 * 同风格）。mock settings 必须带 mergeSettings 补齐的完整字段，与 getSettings 产出对齐。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/storage";
import { TranslationCache, fnv1aHex } from "../src/background/cache";
import { TranslateService } from "../src/background/translate";
import type { Settings } from "../src/shared/types";

type Store = Record<string, unknown>;

/** 开启缓存的完整设置：基于真实默认值，只改 API 端点供 fetch 拦截。
 *  字段与 DEFAULT_SETTINGS 对齐（mergeSettings 会把缺失字段补成默认值）。 */
function withCacheSettings(enabled: boolean): Settings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    api: { ...DEFAULT_SETTINGS.api, baseUrl: "https://example.test/v1", apiKey: "sk-test", model: "m" },
    cache: { ...DEFAULT_SETTINGS.cache, enabled },
  };
}

/** 与 translate.ts applyCacheSettings 同口径的缓存变体：format|model|customPrompt 哈希 */
function cacheVariantOf(settings: Settings): string {
  return fnv1aHex(
    [settings.api.format, settings.api.model, settings.api.customSystemPrompt ?? ""].join("|")
  );
}

/** 内存版 chrome.storage.local（get(null) 全量读支持），返回存储映射供预置/检视 */
function makeMemoryStorage(): Store {
  const store: Store = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string | null) => {
          if (key === null) return { ...store };
          return key in store ? { [key]: store[key] } : {};
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        }),
        remove: vi.fn(async () => undefined),
      },
    },
  } as unknown as typeof chrome;
  return store;
}

/** 用真实的 TranslationCache.set 预置缓存条目（写入 {src,val,ts} 结构 + 变体键） */
async function seedCache(
  store: Store,
  settings: Settings,
  entries: Array<{ text: string; translation: string }>
): Promise<void> {
  store.settings = settings;
  const cache = new TranslationCache();
  const variant = cacheVariantOf(settings);
  for (const e of entries) {
    await cache.set("zh-CN", e.text, e.translation, variant);
  }
}

/** 拦截 provider fetch：记录请求体 user 内容，按 handler 返回译文 */
function stubFetch(handler: (body: { user: string }) => string): {
  calls: { url: string; user: string }[];
} {
  const calls: { url: string; user: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        messages: { role: string; content: string }[];
      };
      const user = body.messages.find((m) => m.role === "user")?.content ?? "";
      calls.push({ url: String(input), user });
      return new Response(JSON.stringify({ choices: [{ message: { content: handler({ user }) } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  return { calls };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("批量缓存命中路径（cache.enabled = true）", () => {
  it("开启缓存 + 全部命中 → 零 provider 请求，results 与输入段一一对应且等于缓存译文", async () => {
    const settings = withCacheSettings(true);
    const store = makeMemoryStorage();
    await seedCache(store, settings, [
      { text: "alpha", translation: "甲" },
      { text: "beta", translation: "乙" },
      { text: "gamma", translation: "丙" },
    ]);
    const { calls } = stubFetch(() => {
      throw new Error("全命中时不应发起任何 provider 请求");
    });
    const svc = new TranslateService();
    const results = await svc.translate(["alpha", "beta", "gamma"], "zh-CN");
    expect(calls).toHaveLength(0);
    expect(results).toEqual(["甲", "乙", "丙"]);
  });

  it("开启缓存 + 部分命中 → 只把未命中文本发一次批量请求（非逐段重发），命中段不进请求体，结果按下标回填", async () => {
    const settings = withCacheSettings(true);
    const store = makeMemoryStorage();
    await seedCache(store, settings, [
      { text: "alpha", translation: "甲" }, // 命中
      // beta 未命中 → 需要请求
      { text: "gamma", translation: "丙" }, // 命中
      // delta 未命中 → 需要请求
    ]);
    const { calls } = stubFetch(({ user }) =>
      user
        .split("\n")
        .slice(1) // 第一行是逐行协议指令前缀
        .map((t) => `译${t}`)
        .join("\n")
    );
    const svc = new TranslateService();
    const results = await svc.translate(["alpha", "beta", "gamma", "delta"], "zh-CN");
    expect(results).toEqual(["甲", "译beta", "丙", "译delta"]);
    // 只有 1 次请求：两段未命中整批合并；命中段绝不在请求体里、绝不重发
    expect(calls).toHaveLength(1);
    expect(calls[0].user).toContain("beta");
    expect(calls[0].user).toContain("delta");
    expect(calls[0].user).not.toContain("alpha");
    expect(calls[0].user).not.toContain("gamma");
  });

  it("对照侧：关闭缓存 + 磁盘有缓存 → 仍发请求（钉住 cacheEnabled 检查不被删）", async () => {
    const settings = withCacheSettings(false);
    const store = makeMemoryStorage();
    await seedCache(store, settings, [{ text: "alpha", translation: "甲" }]);
    const { calls } = stubFetch(() => "API 新译文");
    const svc = new TranslateService();
    const results = await svc.translate(["alpha"], "zh-CN");
    expect(calls).toHaveLength(1);
    expect(results).toEqual(["API 新译文"]);
  });
});
