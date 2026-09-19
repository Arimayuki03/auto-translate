/**
 * 第三方 API provider 请求回归测试：
 * - OpenAI / Anthropic / Gemini / Ollama 的鉴权与请求协议必须与历史版本一致（URL 拼接、请求头、请求体）；
 * - 401/403 归类为 auth 且不可重试，不触发备用 API；
 * - 429/5xx/网络错误可重试，重试耗尽后切换备用 API；
 * - 批量协议：默认逐行（旧版），仅显式配置哨兵才用哨兵；两种协议请求格式固定。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptApiKey, getSettings } from "../src/shared/storage";
import { ApiError, buildApiUrl, postJson } from "../src/background/providers/http";
import { anthropicProvider } from "../src/background/providers/anthropic";
import { geminiProvider } from "../src/background/providers/gemini";
import { ollamaProvider } from "../src/background/providers/ollama";
import { openaiProvider } from "../src/background/providers/openai";
import type { ApiConfig, Settings } from "../src/shared/types";

const BASE_API: ApiConfig = {
  format: "openai",
  baseUrl: "https://example.test/v1",
  apiKey: "sk-test",
  model: "m",
  temperature: 0.3,
  timeoutMs: 60000,
  maxConcurrency: 3,
};

function openAiSettings(overrides?: { api?: Partial<ApiConfig>; backupApi?: ApiConfig }): Settings {
  return {
    version: 4,
    enabled: true,
    api: { ...BASE_API, ...(overrides?.api ?? {}) },
    ...(overrides?.backupApi ? { backupApi: overrides.backupApi } : {}),
    translate: {
      targetLang: "zh-CN",
      displayMode: "bilingual",
      autoTranslate: true,
      autoDetectSource: true,
      minTextLength: 2,
      blockMaxChars: 1200,
      translateOnSelect: true,
      translateInput: true,
      viewportLazy: false,
      terminology: [],
      contextEnabled: true,
      contextMaxChars: 3000,
    },
    sites: { whitelist: [], blacklist: [] },
    tts: { enabled: true, voice: "", rate: 0 },
    security: { encryptApiKey: true, sensitivePages: false },
    cache: { enabled: true, maxEntries: 500 },
  };
}

/** 拦截 fetch：记录请求，按 handler 返回响应（允许返回 Promise，fetch 本就是异步的） */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  });
  vi.stubGlobal("fetch", mock);
  return { calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** mock chrome.storage：settings 按给定对象返回；缓存键读 memory 映射 */
function mockStorage(settings: Settings, memory = new Map<string, string>()): void {
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => {
          if (key === "settings") return { settings };
          const v = memory.get(key);
          return v !== undefined ? { [key]: v } : {};
        }),
        set: vi.fn(async (items: Record<string, string>) => {
          for (const [k, v] of Object.entries(items)) memory.set(k, v);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) memory.delete(k);
        }),
      },
    },
  } as unknown as typeof chrome;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildApiUrl：URL 拼接兼容历史行为", () => {
  it("普通拼接：base + endpoint", () => {
    expect(buildApiUrl("https://api.example.com/v1", "/chat/completions")).toBe(
      "https://api.example.com/v1/chat/completions"
    );
  });
  it("base 带尾斜杠：不产生双斜杠", () => {
    expect(buildApiUrl("https://api.example.com/v1/", "/chat/completions")).toBe(
      "https://api.example.com/v1/chat/completions"
    );
  });
  it("endpoint 含 /v1 与 base 重叠：去重不重复拼接", () => {
    expect(buildApiUrl("https://api.example.com/v1", "/v1/messages")).toBe(
      "https://api.example.com/v1/messages"
    );
  });
  it("Anthropic：base 不带 /v1 也能拼出 /v1/messages", () => {
    expect(buildApiUrl("https://api.anthropic.com", "/v1/messages")).toBe(
      "https://api.anthropic.com/v1/messages"
    );
  });
  it("Gemini：base 带 /v1beta 不重复拼接", () => {
    expect(buildApiUrl("https://generativelanguage.googleapis.com/v1beta", "/v1beta/models/x")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/x"
    );
  });
});

describe("OpenAI 兼容通道请求协议", () => {
  it("POST /chat/completions，Bearer 头，请求体含 model/messages/temperature/stream:false", async () => {
    const { calls } = stubFetch(() => jsonResponse({ choices: [{ message: { content: "译文" } }] }));
    const result = await openaiProvider.chat(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "Hello" },
      ],
      { baseUrl: "https://example.test/v1", apiKey: "sk-test", model: "m", temperature: 0.3, timeoutMs: 60000 }
    );
    expect(result.text).toBe("译文");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://example.test/v1/chat/completions");
    expect(calls[0].init.headers).toMatchObject({ Authorization: "Bearer sk-test" });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.model).toBe("m");
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "Hello" },
    ]);
  });

  it("空 BaseURL 时报错而非静默失败（诊断不误报为鉴权）", async () => {
    // 设置页校验会拦住空 BaseURL，但后台仍需兜底给清晰错误，避免 fetch 直接抛网络错误
    await expect(
      openaiProvider.chat([{ role: "user", content: "hi" }], {
        baseUrl: "",
        apiKey: "k",
        model: "m",
        temperature: 0.3,
        timeoutMs: 60000,
      })
    ).rejects.toThrow("BaseURL");
  });
});

describe("Anthropic 通道请求协议", () => {
  it("POST /v1/messages，x-api-key 头，system 抽出到顶层", async () => {
    const { calls } = stubFetch(() =>
      jsonResponse({ content: [{ type: "text", text: "译文" }] })
    );
    const result = await anthropicProvider.chat(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "Hello" },
      ],
      { baseUrl: "https://example.test/v1", apiKey: "sk-ant", model: "claude", temperature: 0.3, timeoutMs: 60000 }
    );
    expect(result.text).toBe("译文");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://example.test/v1/messages");
    expect(calls[0].init.headers).toMatchObject({ "x-api-key": "sk-ant" });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.system).toBe("sys");
    expect(body.model).toBe("claude");
    expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
  });
});

describe("Gemini 通道请求协议", () => {
  it("x-goog-api-key 请求头带 key（不进 URL），请求体 contents/system_instruction", async () => {
    const { calls } = stubFetch(() =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: "译文" }] } }] })
    );
    const result = await geminiProvider.chat(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "Hello" },
      ],
      { baseUrl: "https://generativelanguage.googleapis.com", apiKey: "g-key", model: "gemini", temperature: 0.3, timeoutMs: 60000 }
    );
    expect(result.text).toBe("译文");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/v1beta/models/gemini:generateContent");
    // key 走 x-goog-api-key 鉴权头（URL 查询参数会被中转站/CDN access log 记录）；URL 中不得再出现 key
    expect(calls[0].init.headers).toMatchObject({ "x-goog-api-key": "g-key" });
    expect(calls[0].url).not.toContain("g-key");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.system_instruction).toEqual({ parts: [{ text: "sys" }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Hello" }] }]);
  });
});

describe("Ollama 通道请求协议", () => {
  it("POST /api/chat，无鉴权头，请求体含 messages/options", async () => {
    const { calls } = stubFetch(() => jsonResponse({ message: { content: "译文" } }));
    const result = await ollamaProvider.chat(
      [{ role: "user", content: "Hello" }],
      { baseUrl: "http://127.0.0.1:11434", apiKey: "", model: "qwen", temperature: 0.3, timeoutMs: 60000 }
    );
    expect(result.text).toBe("译文");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:11434/api/chat");
    expect(calls[0].init.headers).not.toHaveProperty("Authorization");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.model).toBe("qwen");
    expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
  });
});

describe("HTTP 错误归类", () => {
  it.each([
    [401, "auth", false],
    [403, "auth", false],
    [429, "rate_limit", true],
    [404, "not_found", false],
    [500, "server", true],
  ])("状态 %i → code=%s retryable=%s", async (status, code, retryable) => {
    stubFetch(() => jsonResponse({ error: "boom" }, status));
    try {
      await postJson("https://example.test/v1/chat/completions", {}, {}, 60000, "openai");
      expect.unreachable("应抛出 ApiError");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.code).toBe(code);
      expect(e.retryable).toBe(retryable);
      expect(e.diagnostic?.provider).toBe("openai");
      expect(e.diagnostic?.status).toBe(status);
    }
  });

  it("401/403 的诊断信息不含 API Key（脱敏）", async () => {
    stubFetch(() => jsonResponse({ error: "invalid key sk-test" }, 401));
    try {
      await postJson("https://example.test/v1/chat/completions", { Authorization: "Bearer sk-test" }, {}, 60000, "openai");
      expect.unreachable("应抛出 ApiError");
    } catch (err) {
      const e = err as ApiError;
      expect(e.diagnostic?.responsePreview).not.toContain("sk-test");
      expect(e.diagnostic?.responsePreview).toContain("[REDACTED]");
    }
  });
});

describe("响应体读取（A1/B2 回归：读体必须在超时/中止作用域内，失败不得吞成空串）", () => {
  /** 构造一个响应头已到、但读体按给定原因失败的 Response（模拟悬挂/中断的 body） */
  function brokenBodyResponse(rejectReason: unknown, rejectAfterMs = 5): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => controller.error(rejectReason), rejectAfterMs);
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } });
  }

  it("postJson：读体 reject（连接中断）→ 可重试的 network 错误，文案说明读取响应体失败", async () => {
    stubFetch(() => brokenBodyResponse(new TypeError("network error during body read")));
    try {
      await postJson("https://example.test/v1/chat/completions", {}, {}, 60000, "openai");
      expect.unreachable("应抛出 ApiError");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.code).toBe("network");
      expect(e.retryable).toBe(true); // 可重试、可切备用
      expect(e.message).toContain("读取响应体失败");
      expect(e.message).not.toContain("BaseURL"); // 不得误导为配置错误
    }
  });

  it("postJson：读体被超时中止（AbortError 且非会话中止）→ timeout 错误且 promise 会 settle", async () => {
    stubFetch(() => brokenBodyResponse(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })));
    await expect(
      postJson("https://example.test/v1/chat/completions", {}, {}, 60000, "openai")
    ).rejects.toMatchObject({ name: "ApiError", code: "timeout" });
  });

  it("postJson：会话中止打断读体 → 普通 Error('cancelled')，非 ApiError", async () => {
    const ac = new AbortController();
    stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              // body 悬挂：只有外部 abort 才能让它失败
              setTimeout(() => controller.error(Object.assign(new Error("The user aborted a request."), { name: "AbortError" })), 50);
            },
          }),
          { status: 200 }
        )
    );
    const pending = postJson("https://example.test/v1/chat/completions", {}, {}, 5000, "openai", ac.signal);
    setTimeout(() => ac.abort(), 10);
    await expect(pending).rejects.toThrow("cancelled");
    try {
      await pending;
    } catch (err) {
      expect(err).not.toBeInstanceOf(ApiError);
    }
  });

  it("googlefree：读体 reject → 可重试 network 错误（且并发槽已释放，见下条）", async () => {
    const { googleFreeProvider } = await import("../src/background/providers/googlefree");
    stubFetch(() => brokenBodyResponse(new TypeError("network error during body read")));
    try {
      await googleFreeProvider.chat(
        [
          { role: "system", content: "你是专业翻译引擎。将用户输入翻译为zh-CN，只输出译文。" },
          { role: "user", content: "hello" },
        ],
        { baseUrl: "", apiKey: "", model: "", temperature: 0, timeoutMs: 60000 }
      );
      expect.unreachable("应抛出 ApiError");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.code).toBe("network");
      expect(e.retryable).toBe(true);
      expect(e.message).toContain("读取响应体失败");
    }
  });

  it("googlefree：读体失败后并发槽不泄漏——连续 3 次失败后第 4 次请求仍能完成", async () => {
    const { googleFreeProvider } = await import("../src/background/providers/googlefree");
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const q = new URL(String(input)).searchParams.get("q") ?? "";
        if (fail) return brokenBodyResponse(new TypeError("network error during body read"));
        return jsonResponse([[["译" + q, q, null, null, ""]]]);
      })
    );
    const opts = { baseUrl: "", apiKey: "", model: "", temperature: 0, timeoutMs: 60000 };
    // GOOGLE_CONCURRENCY=3：若读体失败后 releaseSlot 未随 finally 执行，槽位逐次泄漏，
    // 第 4 次请求会永久挂在 acquireSlot 上（表现为本用例超时红）
    for (let i = 0; i < 3; i++) {
      await expect(
        googleFreeProvider.chat(
          [
            { role: "system", content: "你是专业翻译引擎。将用户输入翻译为zh-CN，只输出译文。" },
            { role: "user", content: `seg${i}` },
          ],
          opts
        )
      ).rejects.toBeInstanceOf(ApiError);
    }
    fail = false;
    const result = await googleFreeProvider.chat(
      [
        { role: "system", content: "你是专业翻译引擎。将用户输入翻译为zh-CN，只输出译文。" },
        { role: "user", content: "hello" },
      ],
      opts
    );
    expect(result.text).toBe("译hello");
  });

  it("microsoft：读体 reject → 可重试 network 错误", async () => {
    const { microsoftProvider } = await import("../src/background/providers/microsoft");
    stubFetch(() => brokenBodyResponse(new TypeError("network error during body read")));
    try {
      await microsoftProvider.chat(
        [
          { role: "system", content: "你是专业翻译引擎。将用户输入翻译为zh-CN，只输出译文。" },
          { role: "user", content: "hello" },
        ],
        { baseUrl: "", apiKey: "", model: "", temperature: 0, timeoutMs: 60000 }
      );
      expect.unreachable("应抛出 ApiError");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.code).toBe("network");
      expect(e.retryable).toBe(true);
      expect(e.message).toContain("读取响应体失败");
    }
  });
});

describe("TranslateService：主 API 鉴权与备用切换", () => {
  it("主 API 401 → 主通道不重试，切备用 API；备用也 401 则抛带「备用 API」来源的 auth 错误（B1：硬失败仍走备用通道）", async () => {
    mockStorage(openAiSettings({ backupApi: { ...BASE_API, baseUrl: "https://backup.test/v1" } }));
    const { calls } = stubFetch(() => jsonResponse({ error: "unauthorized" }, 401));
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    // 全部通道失败时上抛错误（带错误类型与来源标注），而不是静默返回空串
    try {
      await svc.translate(["hello"], "zh-CN");
      expect.unreachable("401 应抛出 ApiError");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.code).toBe("auth");
      expect(e.retryable).toBe(false);
      expect(e.message).toContain("备用 API"); // 最后失败的通道（B1 前为主 API）
      expect(e.message).toContain("401");
    }
    // 通道内级联短路保持：主通道硬失败不重试；备用通道也只试一次（B1 前为 1 次、不切备用）
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://example.test/v1/chat/completions");
  });

  it("主 API 429 → 重试耗尽后切换备用 API", async () => {
    mockStorage(openAiSettings({ backupApi: { ...BASE_API, baseUrl: "https://backup.test/v1" } }));
    const { calls: fetchCalls } = stubFetch((url) => {
      // 主 API 持续 429，备用 API 返回成功
      if (url.startsWith("https://backup.test")) return jsonResponse({ choices: [{ message: { content: "备用译文" } }] });
      return jsonResponse({ error: "too many" }, 429);
    });
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    const results = await svc.translate(["hello"], "zh-CN");
    expect(results[0]).toBe("备用译文");
    // 主 API 重试（最多 3 次）+ 备用成功，共 1+3+1 次
    expect(fetchCalls).toHaveLength(5);
  });

  it("主 API 正常响应返回译文", async () => {
    mockStorage(openAiSettings());
    stubFetch(() => jsonResponse({ choices: [{ message: { content: "正常译文" } }] }));
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    const results = await svc.translate(["hello"], "zh-CN");
    expect(results[0]).toBe("正常译文");
  });

  it("API Key 在请求前解密（存储为密文，请求头为明文）", async () => {
    const encrypted = encryptApiKey("sk-plain");
    expect(encrypted).not.toBe("sk-plain");
    // 存储层：settings 里是密文
    mockStorage({ ...openAiSettings(), api: { ...BASE_API, apiKey: encrypted } });
    let seenAuth: string | undefined;
    stubFetch((_url, init) => {
      seenAuth = (init.headers as Record<string, string>).Authorization;
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    });
    const settings = await getSettings();
    expect(settings.api.apiKey).toBe("sk-plain"); // 验证 getSettings 会解密密文
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    await svc.translate(["hello"], "zh-CN");
    expect(seenAuth).toBe("Bearer sk-plain");
  });
});

describe("批量协议：默认逐行，哨兵需显式启用", () => {
  it("默认（batchMode 缺省/未配置）→ 旧版逐行协议：system 无哨兵规则，user 为逐行指令", async () => {
    mockStorage(openAiSettings());
    const { calls } = stubFetch(() =>
      jsonResponse({ choices: [{ message: { content: "第一\n第二" } }] })
    );
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    const results = await svc.translate(["aaa", "bbb"], "zh-CN");
    expect(results).toEqual(["第一", "第二"]);
    // 批量一次请求
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.messages[0].content).not.toContain("===IT_SEP===");
    expect(body.messages[1].content).toContain("请逐行翻译以下内容");
    expect(body.messages[1].content).toContain("aaa\nbbb");
  });

  it("batchMode=separator → 哨兵协议：system 含哨兵规则，user 用 ===IT_SEP=== 拼接", async () => {
    mockStorage(openAiSettings({ api: { batchMode: "separator" } }));
    const { calls } = stubFetch(() =>
      jsonResponse({ choices: [{ message: { content: "第一\n===IT_SEP===\n第二" } }] })
    );
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    const results = await svc.translate(["aaa", "bbb"], "zh-CN");
    expect(results).toEqual(["第一", "第二"]);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.messages[0].content).toContain("===IT_SEP===");
    expect(body.messages[1].content).toBe("aaa\n===IT_SEP===\nbbb");
  });

  it("哨兵协议解析失败 → 自动重试旧版逐行协议（不直接逐段降级）", async () => {
    mockStorage(openAiSettings({ api: { batchMode: "separator" } }));
    const bodies: unknown[] = [];
    const { calls } = stubFetch((_url, init) => {
      const body = JSON.parse(init.body as string) as { messages: { role: string; content: string }[] };
      bodies.push(body);
      const user = body.messages[1].content;
      // 哨兵请求：返回不可解析的畸形内容（含哨兵但段数不符）→ 触发逐行回退；
      // 逐行重试：返回正确格式
      return jsonResponse({
        choices: [{ message: { content: user.includes("===IT_SEP===") ? "残\n缺\n段" : "第一\n第二" } }],
      });
    });
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    const results = await svc.translate(["aaa", "bbb"], "zh-CN");
    expect(results).toEqual(["第一", "第二"]);
    // 第一次哨兵请求 + 第二次逐行重试 = 2 次，未走逐段
    expect(calls).toHaveLength(2);
    const first = bodies[0] as { messages: { role: string; content: string }[] };
    const second = bodies[1] as { messages: { role: string; content: string }[] };
    expect(first.messages[1].content).toContain("===IT_SEP===");
    expect(second.messages[1].content).toContain("请逐行翻译以下内容");
  });

  it("哨兵协议但原文含 ===IT_SEP=== → 强制逐行协议，避免分段歧义", async () => {
    mockStorage(openAiSettings({ api: { batchMode: "separator" } }));
    const { calls } = stubFetch(() =>
      jsonResponse({ choices: [{ message: { content: "第一\n第二" } }] })
    );
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    // 其中一段原文本身含哨兵字符串 → 哨兵分段必然歧义，必须退回逐行
    const results = await svc.translate(["aaa ===IT_SEP=== bbb", "ccc"], "zh-CN");
    expect(results).toEqual(["第一", "第二"]);
    // 只发一次请求（不先试探哨兵协议再回退），直接用逐行协议
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].init.body as string);
    // system 不含哨兵分段规则；user 用逐行指令（原文里的哨兵字符串只是普通文本，不作分隔符）
    expect(body.messages[0].content).not.toContain("批量分段规则");
    expect(body.messages[1].content).toContain("请逐行翻译以下内容");
  });

  it("逐行协议下批量解析失败 → 逐段降级，不试探哨兵协议", async () => {
    mockStorage(openAiSettings());
    // 返回 1 行但期望 2 段：splitBatch 返回 null → 走逐段降级
    const { calls } = stubFetch(() =>
      jsonResponse({ choices: [{ message: { content: "只有一行" } }] })
    );
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    const results = await svc.translate(["aaa", "bbb"], "zh-CN");
    expect(results).toEqual(["只有一行", "只有一行"]); // 每段单独翻译拿到同一结果
    // 1 次批量 + 2 次逐段 = 3 次请求
    expect(calls).toHaveLength(3);
    // 默认逐行协议下绝不该发出哨兵提示词（第三方模型可能因此拒答）
    for (const c of calls) {
      const body = JSON.parse(c.init.body as string);
      expect(body.messages[0].content).not.toContain("===IT_SEP===");
    }
  });
});

describe("Google 免费通道批量协议（F-1：固定哨兵，指令前缀绝不进请求）", () => {
  function googleFreeSettings(): Settings {
    return openAiSettings({
      api: { format: "googlefree", baseUrl: "", apiKey: "", model: "" },
    });
  }

  it("默认逐行配置下也固定哨兵协议：批量请求不含逐行指令前缀，解析一次成功", async () => {
    const { calls } = stubFetch((url) => {
      const q = new URL(url).searchParams.get("q") ?? "";
      // translate_a/single 实际响应：[[[译文, 原文, ...], ...], ...]
      return jsonResponse([[["译" + q, q, null, null, ""]]]);
    });
    mockStorage(googleFreeSettings());
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    const results = await svc.translate(["Hello", "World"], "zh-CN");
    expect(results).toEqual(["译Hello", "译World"]);
    // 一次批量调用：googlefree 内部逐段并发，各打一次 Google
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      const q = new URL(c.url).searchParams.get("q") ?? "";
      // 只发送原文本身：逐行指令前缀 / 哨兵分隔符绝不当作待译段发给 Google
      expect(["Hello", "World"]).toContain(q);
      expect(q).not.toContain("请逐行翻译");
      expect(q).not.toContain("===IT_SEP===");
    }
  });
});

describe("会话中止打断在途请求（F-3：signal 接线到 fetch）", () => {
  it("还原/换页触发的 abort 会打断在途 fetch，translate 抛 TranslationCancelledError", async () => {
    const ac = new AbortController();
    // fetch 挂起直到被中止：模拟一个迟迟不返回的在途请求
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("The user aborted a request."), { name: "AbortError" }))
          );
        })
    );
    mockStorage(openAiSettings());
    const { TranslateService, TranslationCancelledError } = await import(
      "../src/background/translate"
    );
    const svc = new TranslateService();
    const pending = svc.translate(["hello"], "zh-CN", undefined, ac.signal);
    setTimeout(() => ac.abort(), 10);
    await expect(pending).rejects.toBeInstanceOf(TranslationCancelledError);
  });

  it("postJson：会话 signal 中止时抛普通 Error（非 ApiError，不触发重试/备用）", async () => {
    const ac = new AbortController();
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("The user aborted a request."), { name: "AbortError" }))
          );
        })
    );
    const pending = postJson("https://example.test/v1/chat/completions", {}, {}, 5000, "openai", ac.signal);
    setTimeout(() => ac.abort(), 10);
    await expect(pending).rejects.toThrow("cancelled");
    try {
      await pending;
    } catch (err) {
      expect(err).not.toBeInstanceOf(ApiError);
    }
  });
});

describe("降级放大上限（批量解析失败 → 先拆 8 段小批量，而非直接逐段）", () => {
  it("20 段整批解析失败 → 1 次整批 + 3 次小批量成功，请求量 4 而非 21", async () => {
    mockStorage(openAiSettings());
    const { calls } = stubFetch((_url, init) => {
      const body = JSON.parse(init.body as string);
      const user = body.messages[1].content as string;
      const lines = user.split("\n");
      const count = lines.length - 1; // 第一行是逐行指令前缀
      if (count > 8) {
        // 大批量被模型弄乱：只回一行 → 行数不符 → 解析失败
        return jsonResponse({ choices: [{ message: { content: "模型输出乱掉了" } }] });
      }
      const texts = lines.slice(1);
      return jsonResponse({
        choices: [{ message: { content: texts.map((t: string) => `译${t}`).join("\n") } }],
      });
    });
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    const texts = Array.from({ length: 20 }, (_, i) => `段落${i}`);
    const results = await svc.translate(texts, "zh-CN");
    expect(results).toEqual(texts.map((t) => `译${t}`));
    // 1 次整批（解析失败）+ ⌈20/8⌉=3 次小批量（成功）= 4 次；逐段风暴（+20）不应发生
    expect(calls).toHaveLength(4);
  });

  it("API 硬失败（401 鉴权）短路：不拆小批量、不逐段降级，整批只发 1 次请求", async () => {
    // （限速器贯通由下方 minRequestIntervalMs 专项用例覆盖，此处不再借 21 次请求验证）
    mockStorage(openAiSettings({ api: { minRequestIntervalMs: 50 } }));
    const { calls } = stubFetch(() => jsonResponse({ error: "unauthorized" }, 401));
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    const texts = Array.from({ length: 20 }, (_, i) => `段落${i}`);
    try {
      await svc.translate(texts, "zh-CN");
      expect.unreachable("401 应抛出");
    } catch (err) {
      expect((err as ApiError).code).toBe("auth");
    }
    // 鉴权失败与请求粒度无关：硬失败直接上抛，不得放大成 1+N 次（旧「401 逐段 21 次」行为已废弃）
    expect(calls).toHaveLength(1);
  });

  it("minRequestIntervalMs 生效：间隔 1000ms 时第 3 个请求须等待令牌补充", async () => {
    mockStorage(openAiSettings({ api: { minRequestIntervalMs: 1000, maxConcurrency: 2 } }));
    const { calls } = stubFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    const t1 = Date.now();
    await svc.translate(["a"], "zh-CN");
    await svc.translate(["b"], "zh-CN");
    await svc.translate(["c"], "zh-CN");
    const span = Date.now() - t1;
    expect(calls).toHaveLength(3);
    // 容量 2 允许前 2 个突发；第 3 个须等 ~1 个令牌周期（1000ms）
    expect(span).toBeGreaterThanOrEqual(900);
  });
});
