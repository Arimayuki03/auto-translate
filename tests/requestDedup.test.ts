/**
 * 跨标签页请求去重回归测试：
 * - 相同 文本+目标语言 的并发请求共享同一次执行（多标签页翻同一站点不重复耗额度）；
 * - 不同文本/语言不去重；
 * - 共享请求被「其他会话」中止时，仍在翻译的等待者自行重发，不把中止扩散给无辜方。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranslateService } from "../src/background/translate";
import type { Settings } from "../src/shared/types";

function openaiSettings(): Settings {
  return {
    version: 4,
    enabled: true,
    api: {
      format: "openai",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
      model: "m",
      temperature: 0.3,
      timeoutMs: 60000,
      maxConcurrency: 2,
    },
    translate: {
      targetLang: "zh-CN",
      displayMode: "bilingual",
      autoTranslate: false,
      autoDetectSource: true,
      minTextLength: 2,
      blockMaxChars: 1200,
      translateOnSelect: true,
      translateInput: true,
      viewportLazy: false,
      terminology: [],
    },
    sites: { whitelist: [], blacklist: [] },
    tts: { enabled: true, voice: "", rate: 0 },
    security: { encryptApiKey: false, sensitivePages: false },
    cache: { enabled: false, maxEntries: 100 },
  };
}

beforeEach(() => {
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: unknown) =>
          key === "settings" ? { settings: openaiSettings() } : {}
        ),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    },
  } as unknown as typeof chrome;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function openaiResponse(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("跨标签页请求去重", () => {
  it("相同文本+语言的并发请求只发一次，共享同一结果", async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 30));
        return openaiResponse(`译-${fetchCount}`);
      })
    );
    const svc = new TranslateService();
    const [a, b, c] = await Promise.all([
      svc.translate(["hello"], "zh-CN"),
      svc.translate(["hello"], "zh-CN"),
      svc.translate(["hello"], "zh-CN"),
    ]);
    expect(fetchCount).toBe(1);
    expect(a).toEqual(["译-1"]);
    expect(b).toEqual(["译-1"]);
    expect(c).toEqual(["译-1"]);
  });

  it("文本或目标语言不同则不共享", async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount++;
        return openaiResponse(`译-${fetchCount}`);
      })
    );
    const svc = new TranslateService();
    await Promise.all([
      svc.translate(["hello"], "zh-CN"),
      svc.translate(["world"], "zh-CN"),
      svc.translate(["hello"], "ja"),
    ]);
    expect(fetchCount).toBe(3);
  });

  it("共享请求被其他会话中止：等待者自行重发，不把中止扩散给无辜方", async () => {
    // fetch 挂起直到被 abort 或超时自然完成（模拟慢速在途请求）
    const fetchMock = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          const onAbort = () => reject(new DOMException("aborted", "AbortError"));
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener("abort", onAbort);
          setTimeout(() => resolve(openaiResponse("译文")), 40);
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const svc = new TranslateService();
    const acA = new AbortController();
    const acB = new AbortController();
    const pa = svc.translate(["hello"], "zh-CN", undefined, acA.signal); // A 先到 = 共享请求的属主
    const pb = svc.translate(["hello"], "zh-CN", undefined, acB.signal); // B 加入共享
    await new Promise((r) => setTimeout(r, 5));
    acA.abort(); // A 还原页面 → 属主会话中止

    await expect(pa).rejects.toThrow("翻译已取消");
    expect(await pb).toEqual(["译文"]); // B 自己重发并拿到结果
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("属主已中止时不加入共享，直接自建请求", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => openaiResponse("译文"))
    );
    const svc = new TranslateService();
    const ac = new AbortController();
    ac.abort(); // 先中止再发起：应立即抛「翻译已取消」，不发请求
    await expect(svc.translate(["hello"], "zh-CN", undefined, ac.signal)).rejects.toThrow(
      "翻译已取消"
    );
    expect(vi.mocked(fetch).mock.calls.length).toBe(0);
  });
});
