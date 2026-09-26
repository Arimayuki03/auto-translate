/**
 * LLM 页面上下文摘要回归测试（background / 单元层）：
 * - SummaryCache：读写往返 / 变体隔离 / TTL 过期 / 哈希碰撞校验 / 清理 / 清空；
 * - TranslateService.generatePageSummary：开关与免费通道短路、缓存命中不再请求、失败静默回 ""；
 * - 摘要注入批量请求的系统提示词（文章摘要字段）。
 * （content 引擎集成见 pageSummaryEngine.test.ts，jsdom 环境）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uninstallChromeMock } from "./helpers/chromeMock";
import { SummaryCache, fnv1aHex } from "../src/background/cache";
import { TranslateService } from "../src/background/translate";
import { DEFAULT_SETTINGS } from "../src/shared/storage";
import type { ApiConfig, Settings } from "../src/shared/types";

// ===== 工具 =====

type StorageMemory = Map<string, unknown>;

function mockStorage(settings?: Settings): StorageMemory {
  const memory: StorageMemory = new Map();
  if (settings) memory.set("settings", settings);
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string | null) => {
          if (key === null) return Object.fromEntries(memory);
          const v = memory.get(key);
          return v !== undefined ? { [key]: v } : {};
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

const API: ApiConfig = {
  format: "openai",
  baseUrl: "https://example.test/v1",
  apiKey: "sk-test",
  model: "m",
  temperature: 0.3,
  timeoutMs: 60000,
  maxConcurrency: 3,
};

function makeSettings(overrides?: {
  api?: Partial<ApiConfig>;
  summaryEnabled?: boolean;
  summaryMinChars?: number;
}): Settings {
  const base = structuredClone(DEFAULT_SETTINGS);
  return {
    ...base,
    api: { ...base.api, ...API, ...(overrides?.api ?? {}) },
    backupApi: undefined,
    translate: {
      ...base.translate,
      ...(overrides?.summaryEnabled !== undefined
        ? { summaryEnabled: overrides.summaryEnabled }
        : {}),
      ...(overrides?.summaryMinChars !== undefined
        ? { summaryMinChars: overrides.summaryMinChars }
        : {}),
    },
  };
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  calls: { url: string; body: string }[];
} {
  const calls: { url: string; body: string }[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? "") });
    return handler(url, init ?? {});
  });
  vi.stubGlobal("fetch", mock);
  return { calls };
}

function openAiOk(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function parsePayload(body: string): { messages: { role: string; content: string }[] } {
  return JSON.parse(body);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  uninstallChromeMock();
  vi.unstubAllGlobals();
});

// ===== SummaryCache =====

describe("SummaryCache", () => {
  it("set/get 往返、跨实例磁盘持久（新实例内存未命中读磁盘）", async () => {
    mockStorage();
    const a = new SummaryCache();
    await a.set("标题", "正文内容", "这是摘要", "v1");
    const b = new SummaryCache(); // 模拟 SW 重启后的新实例
    await expect(b.get("标题", "正文内容", "v1")).resolves.toBe("这是摘要");
  });

  it("变体隔离：不同模型变体不互相命中", async () => {
    mockStorage();
    const cache = new SummaryCache();
    await cache.set("标题", "正文", "模型A的摘要", "variant-a");
    await expect(cache.get("标题", "正文", "variant-a")).resolves.toBe("模型A的摘要");
    await expect(cache.get("标题", "正文", "variant-b")).resolves.toBeUndefined();
  });

  it("TTL 过期后未命中（直接往磁盘写旧时间戳）", async () => {
    const memory = mockStorage();
    const cache = new SummaryCache();
    cache.ttlDays = 7;
    const key = `it-summary:${fnv1aHex(`v|标题|2|正文`)}`;
    memory.set(key, {
      src: fnv1aHex("标题|正文"),
      val: "旧摘要",
      ts: Date.now() - 8 * 24 * 60 * 60 * 1000,
    });
    await expect(cache.get("标题", "正文", "v")).resolves.toBeUndefined();
  });

  it("哈希碰撞校验：src 不匹配视为未命中，不会把别的页面的摘要当本页返回", async () => {
    const memory = mockStorage();
    const cache = new SummaryCache();
    // 模拟键碰撞：同键写入一个 src 错误的条目，读取必须判未命中
    const key = `it-summary:${fnv1aHex(`v|标题|2|正文`)}`;
    memory.set(key, { src: "wrong-src", val: "别人的摘要", ts: Date.now() });
    await expect(cache.get("标题", "正文", "v")).resolves.toBeUndefined();
  });

  it("空摘要不缓存；cleanupExpired 移除过期条目并返回条数", async () => {
    const memory = mockStorage();
    const cache = new SummaryCache();
    await cache.set("标题", "正文", "   ", "v");
    const key = `it-summary:${fnv1aHex(`v|标题|2|正文`)}`;
    expect(memory.has(key)).toBe(false);

    memory.set(key, { src: fnv1aHex("标题|正文"), val: "旧", ts: 1 });
    memory.set("it-summary:deadbeef", { src: "x", val: "y", ts: Date.now() });
    const removed = await cache.cleanupExpired();
    expect(removed).toBe(1);
    expect(memory.has(key)).toBe(false);
    expect(memory.has("it-summary:deadbeef")).toBe(true);
  });

  it("clear 清空内存与磁盘", async () => {
    const memory = mockStorage();
    const cache = new SummaryCache();
    await cache.set("标题", "正文", "摘要", "v");
    expect(memory.size).toBe(1);
    await cache.clear();
    expect(memory.size).toBe(0);
    await expect(cache.get("标题", "正文", "v")).resolves.toBeUndefined();
  });
});

// ===== TranslateService.generatePageSummary =====

describe("generatePageSummary", () => {
  it("设置关闭时短路：不发请求", async () => {
    mockStorage(makeSettings({ summaryEnabled: false }));
    const { calls } = stubFetch(() => openAiOk("摘要"));
    const svc = new TranslateService();
    await expect(svc.generatePageSummary("标题", "正文")).resolves.toBe("");
    expect(calls).toHaveLength(0);
  });

  it("免费通道短路：googlefree/microsoft 不发请求（纯翻译端点无法执行摘要指令）", async () => {
    for (const format of ["googlefree", "microsoft"] as const) {
      mockStorage(makeSettings({ summaryEnabled: true, api: { format, baseUrl: "" } }));
      const { calls } = stubFetch(() => openAiOk("摘要"));
      const svc = new TranslateService();
      await expect(svc.generatePageSummary("标题", "正文")).resolves.toBe("");
      expect(calls).toHaveLength(0);
    }
  });

  it("空正文短路：不发请求", async () => {
    mockStorage(makeSettings({ summaryEnabled: true }));
    const { calls } = stubFetch(() => openAiOk("摘要"));
    const svc = new TranslateService();
    await expect(svc.generatePageSummary("标题", "   ")).resolves.toBe("");
    expect(calls).toHaveLength(0);
  });

  it("LLM 生成：请求携带摘要提示词与标题/正文，返回摘要并落盘缓存（二次调用命中不再请求）", async () => {
    mockStorage(makeSettings({ summaryEnabled: true }));
    const { calls } = stubFetch(() => openAiOk("这是文章摘要。第二句。"));
    const svc = new TranslateService();
    const longContent = "x".repeat(2000);
    await expect(svc.generatePageSummary("页面标题", longContent)).resolves.toBe(
      "这是文章摘要。第二句。"
    );
    expect(calls).toHaveLength(1);
    const payload = parsePayload(calls[0].body);
    expect(payload.messages[0].content).toContain("摘要");
    expect(payload.messages[1].content).toContain("页面标题");
    expect(payload.messages[1].content).toContain(longContent);

    // 同一页面第二次（新实例走磁盘缓存层）：不再发请求
    const svc2 = new TranslateService();
    await expect(svc2.generatePageSummary("页面标题", longContent)).resolves.toBe(
      "这是文章摘要。第二句。"
    );
    expect(calls).toHaveLength(1);
  });

  it("超长摘要按上限截断", async () => {
    mockStorage(makeSettings({ summaryEnabled: true }));
    stubFetch(() => openAiOk("长".repeat(1000)));
    const svc = new TranslateService();
    const summary = await svc.generatePageSummary("标题", "正文内容");
    expect(summary).toHaveLength(600);
  });

  it("请求失败静默返回空串（不缓存失败结果）", async () => {
    mockStorage(makeSettings({ summaryEnabled: true }));
    const { calls } = stubFetch(() => new Response("boom", { status: 500 }));
    const svc = new TranslateService();
    await expect(svc.generatePageSummary("标题", "正文内容")).resolves.toBe("");
    // best-effort：至多一次重试，不烧满 3 次重试
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("同页并发请求去重：两个调用共享一次生成", async () => {
    mockStorage(makeSettings({ summaryEnabled: true }));
    let n = 0;
    const { calls } = stubFetch(async () => {
      n++;
      await new Promise((r) => setTimeout(r, 5));
      return openAiOk(`摘要${n}`);
    });
    const svc = new TranslateService();
    const [a, b] = await Promise.all([
      svc.generatePageSummary("标题", "正文内容"),
      svc.generatePageSummary("标题", "正文内容"),
    ]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });

  it("中止信号：已中止时直接返回空串，不发请求", async () => {
    mockStorage(makeSettings({ summaryEnabled: true }));
    const { calls } = stubFetch(() => openAiOk("摘要"));
    const svc = new TranslateService();
    const controller = new AbortController();
    controller.abort();
    await expect(svc.generatePageSummary("标题", "正文", controller.signal)).resolves.toBe("");
    expect(calls).toHaveLength(0);
  });
});

// ===== 摘要注入批量请求系统提示词 =====

describe("摘要注入上下文", () => {
  it("context.summary 存在时，请求的 system 提示词包含「文章摘要」字段", async () => {
    mockStorage(makeSettings());
    const { calls } = stubFetch(() => openAiOk("你好"));
    const svc = new TranslateService();
    await svc.translate(["hello world"], "zh-CN", {
      title: "页面标题",
      description: "描述",
      content: "正文截断",
      summary: "LLM 生成的摘要",
    });
    expect(calls).toHaveLength(1);
    const payload = parsePayload(calls[0].body);
    const system = payload.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("文章摘要：LLM 生成的摘要");
    expect(system).toContain("正文摘要：正文截断");
  });

  it("context.summary 缺省时提示词不含「文章摘要」字段（历史行为不变）", async () => {
    mockStorage(makeSettings());
    const { calls } = stubFetch(() => openAiOk("你好"));
    const svc = new TranslateService();
    await svc.translate(["hello world"], "zh-CN", {
      title: "页面标题",
      description: "描述",
      content: "正文截断",
    });
    const payload = parsePayload(calls[0].body);
    const system = payload.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).not.toContain("文章摘要");
    expect(system).toContain("正文摘要：正文截断");
  });
});
