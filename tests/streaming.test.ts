/**
 * 划词流式翻译回归测试：
 * - SSE / NDJSON 解析（postSSE / postNDJSONLines）：跨 chunk 切断、CRLF、结尾无空行；
 * - openai / anthropic / gemini / ollama 流式协议与增量拼接（delta 结构差异各自锁定）；
 * - 流式失败回退非流式一次；已产出增量不回退（防「前半段+整段」重复文本）；
 * - TranslateService.translateStream：增量转发、缓存命中不发请求、中止归一化为取消错误；
 * - {{NO_TRANSLATION_NEEDED}} 免译哨兵：批量注入与解析映射、原文含哨兵字样时本批不注入、
 *   免费通道不注入但解析兜底映射；
 * - 自定义 prompt：拼在系统提示词最前，批量协议指令完整保留在其后。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postNDJSONLines, postSSE } from "../src/background/providers/http";
import { anthropicProvider } from "../src/background/providers/anthropic";
import { geminiProvider } from "../src/background/providers/gemini";
import { ollamaProvider } from "../src/background/providers/ollama";
import { openaiProvider } from "../src/background/providers/openai";
import type { ApiConfig, Settings } from "../src/shared/types";
import { TranslateError, translateTextStream } from "../src/content/translate";

const BASE_API: ApiConfig = {
  format: "openai",
  baseUrl: "https://example.test/v1",
  apiKey: "sk-test",
  model: "m",
  temperature: 0.3,
  timeoutMs: 60000,
  maxConcurrency: 3,
  minRequestIntervalMs: 50, // 测试提速：请求启动限速降到 50ms
};

function openAiSettings(overrides?: { api?: Partial<ApiConfig>; backupApi?: ApiConfig }): Settings {
  return {
    version: 4,
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
    security: { encryptApiKey: true, sensitivePages: false },
    cache: { enabled: true, maxEntries: 500 },
  };
}

/** 拦截 fetch：记录请求，按 handler 返回响应 */
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

/** 构造 SSE 响应：frames 逐个作为独立 chunk 入队（可模拟跨 chunk 切断） */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** 构造错误中断的流：先产出一段正常帧再异步 error（error() 会丢弃已入队 chunk，必须异步） */
function brokenStreamResponse(firstFrame: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(firstFrame));
      setTimeout(() => controller.error(new Error("connection reset")), 5);
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** mock chrome.storage：settings 按给定对象返回；缓存键读写 memory 映射 */
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
  // 关键：threads 池的 worker 会跨测试文件复用 globalThis —— 不清掉本文件的
  // chrome mock，后续在同一 worker 里运行的 jsdom 引擎测试会被残留 mock 干扰
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe("postSSE：SSE 解析", () => {
  it("逐事件回调 data 负载；[DONE] 原样透传", async () => {
    const payloads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(["data: {\"a\":1}\n\n", "data: [DONE]\n\n"])
      )
    );
    await postSSE("https://example.test/sse", {}, {}, 5000, "openai", undefined, (p) =>
      payloads.push(p)
    );
    expect(payloads).toEqual(['{"a":1}', "[DONE]"]);
  });

  it("跨 chunk 切断的事件边界 / CRLF 分隔 / 结尾无空行兜底", async () => {
    const payloads: string[] = [];
    const frames = [
      'data: {"a":1}\r\n\r\ndata: {"b":',
      '2}\n\n:event ignored\ndata: tail',
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200 }))
    );
    await postSSE("https://example.test/sse", {}, {}, 5000, "openai", undefined, (p) =>
      payloads.push(p)
    );
    expect(payloads).toEqual(['{"a":1}', '{"b":2}', "tail"]);
  });

  it("多行 data: 事件按换行拼接；注释行忽略", async () => {
    const payloads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([": ping\ndata: line1\ndata: line2\n\n"]))
    );
    await postSSE("https://example.test/sse", {}, {}, 5000, "openai", undefined, (p) =>
      payloads.push(p)
    );
    expect(payloads).toEqual(["line1\nline2"]);
  });
});

describe("postNDJSONLines：逐行解析", () => {
  it("跨 chunk 的行边界正确切分；结尾无换行的最后一行兜底", async () => {
    const lines: string[] = [];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"a":1}\n{"b":'));
        controller.enqueue(encoder.encode('2}\n{"c":3}'));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200 }))
    );
    await postNDJSONLines("https://example.test/ndjson", {}, {}, 5000, "ollama", undefined, (l) =>
      lines.push(l)
    );
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
});

describe("OpenAI 流式协议", () => {
  it("SSE 增量 choices[0].delta.content 拼接为全文；请求体 stream:true", async () => {
    const { calls } = stubFetch(() =>
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "你" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "好" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ])
    );
    const deltas: string[] = [];
    const result = await openaiProvider.chat(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "Hello" },
      ],
      {
        ...BASE_API,
        stream: { onDelta: (d) => deltas.push(d) },
      }
    );
    expect(deltas).toEqual(["你", "好"]);
    expect(result.text).toBe("你好");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "Hello" },
    ]);
  });

  it("端点不支持流式（404）→ 回退非流式重试一次（共 2 次请求）", async () => {
    const { calls } = stubFetch((_url, init) => {
      if (JSON.parse(init.body as string).stream === true) return jsonResponse({ error: "x" }, 404);
      return jsonResponse({ choices: [{ message: { content: "整段译文" } }] });
    });
    const deltas: string[] = [];
    const result = await openaiProvider.chat([{ role: "user", content: "Hello" }], {
      ...BASE_API,
      stream: { onDelta: (d) => deltas.push(d) },
    });
    expect(result.text).toBe("整段译文");
    expect(deltas).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1].init.body as string).stream).toBe(false);
  });

  it("已产出增量后流中断 → 不回退（回退会重复输出整段文本）", async () => {
    const { calls } = stubFetch(() =>
      brokenStreamResponse(`data: ${JSON.stringify({ choices: [{ delta: { content: "你" } }] })}\n\n`)
    );
    const deltas: string[] = [];
    await expect(
      openaiProvider.chat([{ role: "user", content: "Hello" }], {
        ...BASE_API,
        stream: { onDelta: (d) => deltas.push(d) },
      })
    ).rejects.toThrow();
    expect(deltas).toEqual(["你"]);
    expect(calls).toHaveLength(1);
  });

  it("未设置 stream 选项时走非流式（请求体 stream:false）", async () => {
    const { calls } = stubFetch(() => jsonResponse({ choices: [{ message: { content: "整段" } }] }));
    const result = await openaiProvider.chat([{ role: "user", content: "Hello" }], BASE_API);
    expect(result.text).toBe("整段");
    expect(JSON.parse(calls[0].init.body as string).stream).toBe(false);
  });
});

describe("Anthropic 流式协议", () => {
  it("content_block_delta(text_delta) 增量拼接；system 抽出顶层；stream:true", async () => {
    const { calls } = stubFetch(() =>
      sseResponse([
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start" })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "早上" },
        })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "好" },
        })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ])
    );
    const deltas: string[] = [];
    const result = await anthropicProvider.chat(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "Hello" },
      ],
      {
        ...BASE_API,
        apiKey: "sk-ant",
        stream: { onDelta: (d) => deltas.push(d) },
      }
    );
    expect(deltas).toEqual(["早上", "好"]);
    expect(result.text).toBe("早上好");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.stream).toBe(true);
    expect(body.system).toBe("sys");
    expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
  });
});

describe("Gemini 流式协议", () => {
  it("streamGenerateContent?alt=sse，candidates[0].content.parts 增量拼接", async () => {
    const { calls } = stubFetch(() =>
      sseResponse([
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: "昨天" }] } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: "下雨" }, { text: "了" }] } }],
        })}\n\n`,
      ])
    );
    const deltas: string[] = [];
    const result = await geminiProvider.chat([{ role: "user", content: "Hello" }], {
      ...BASE_API,
      apiKey: "g-key",
      model: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      stream: { onDelta: (d) => deltas.push(d) },
    });
    expect(deltas).toEqual(["昨天", "下雨", "了"]);
    expect(result.text).toBe("昨天下雨了");
    expect(calls[0].url).toContain(":streamGenerateContent");
    expect(calls[0].url).toContain("alt=sse");
    expect(calls[0].url).toContain("key=g-key");
  });
});

describe("Ollama 流式协议", () => {
  it("NDJSON 行 message.content 增量拼接；请求体 stream:true", async () => {
    const { calls } = stubFetch(() =>
      sseResponse([
        `${JSON.stringify({ message: { content: "你好" } })}\n`,
        `${JSON.stringify({ message: { content: "呀" } })}\n`,
        `${JSON.stringify({ done: true })}\n`,
      ])
    );
    const deltas: string[] = [];
    const result = await ollamaProvider.chat([{ role: "user", content: "Hello" }], {
      ...BASE_API,
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen",
      stream: { onDelta: (d) => deltas.push(d) },
    });
    expect(deltas).toEqual(["你好", "呀"]);
    expect(result.text).toBe("你好呀");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.stream).toBe(true);
  });
});

describe("TranslateService.translateStream：Port 流式管线", () => {
  it("增量经 onDelta 转发；完成后全文返回并写缓存（二次调用不发请求）", async () => {
    const memory = new Map<string, string>();
    mockStorage(openAiSettings(), memory);
    const { calls } = stubFetch(() =>
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "你好" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "世界" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ])
    );
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    const deltas: string[] = [];
    const first = await svc.translateStream("hello", "zh-CN", (d) => deltas.push(d));
    expect(deltas).toEqual(["你好", "世界"]);
    expect(first).toBe("你好世界");
    expect(calls).toHaveLength(1);

    // 缓存命中：第二次同文本直接返回，不发请求、不产增量
    const secondDeltas: string[] = [];
    const second = await svc.translateStream("hello", "zh-CN", (d) => secondDeltas.push(d));
    expect(second).toBe("你好世界");
    expect(secondDeltas).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("中止（气泡关闭 → Port 断开 → signal）打断在途流，归一化为 TranslationCancelledError", async () => {
    const ac = new AbortController();
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
    const pending = svc.translateStream("hello", "zh-CN", () => undefined, ac.signal);
    setTimeout(() => ac.abort(), 10);
    await expect(pending).rejects.toBeInstanceOf(TranslationCancelledError);
  });

  it("主 API 可重试失败且未产出增量 → 切备用 API 流式翻译", async () => {
    mockStorage(
      openAiSettings({ backupApi: { ...BASE_API, baseUrl: "https://backup.test/v1" } })
    );
    const { calls } = stubFetch((url) => {
      if (url.startsWith("https://backup.test")) {
        return sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: "备" } }] })}\n\n`]);
      }
      return jsonResponse({ error: "boom" }, 500);
    });
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    const deltas: string[] = [];
    const result = await svc.translateStream("hello", "zh-CN", (d) => deltas.push(d));
    expect(result).toBe("备");
    expect(deltas).toEqual(["备"]);
    expect(calls[0].url).toBe("https://example.test/v1/chat/completions");
    expect(calls[calls.length - 1].url).toBe("https://backup.test/v1/chat/completions");
  });
});

describe("{{NO_TRANSLATION_NEEDED}} 免译哨兵", () => {
  it("批量中某段输出严格等于哨兵 → 该段返回原文（逐行协议）", async () => {
    mockStorage(openAiSettings());
    stubFetch(() =>
      jsonResponse({ choices: [{ message: { content: "{{NO_TRANSLATION_NEEDED}}\n第二段" } }] })
    );
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    const results = await svc.translate(["Hello world", "World"], "zh-CN");
    expect(results).toEqual(["Hello world", "第二段"]);
  });

  it("批量协议 system 追加免译规则；原文含哨兵字样时本批不注入", async () => {
    mockStorage(openAiSettings());
    const { calls } = stubFetch(() =>
      jsonResponse({ choices: [{ message: { content: "一\n二" } }] })
    );
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    await svc.translate(["Hello", "World"], "zh-CN");
    let body = JSON.parse(calls[0].init.body as string);
    expect(body.messages[0].content).toContain("{{NO_TRANSLATION_NEEDED}}");
    expect(body.messages[0].content).toContain("免译规则");

    await svc.translate(["see {{NO_TRANSLATION_NEEDED}} doc", "World"], "zh-CN");
    body = JSON.parse(calls[1].init.body as string);
    // 原文本身含哨兵字符串 → 本批不注入免译指令，避免模型回显歧义
    expect(body.messages[0].content).not.toContain("免译规则");
  });

  it("免费通道不注入免译指令，但解析同样兜底映射为原文", async () => {
    mockStorage(openAiSettings({ api: { format: "googlefree", baseUrl: "", apiKey: "", model: "" } }));
    const { calls } = stubFetch((url) => {
      const q = new URL(url).searchParams.get("q") ?? "";
      if (q === "Hello") {
        // Google 端点"返回"了哨兵字样（兜底场景）
        return jsonResponse([[["{{NO_TRANSLATION_NEEDED}}", q, null, null, ""]]]);
      }
      return jsonResponse([[["译" + q, q, null, null, ""]]]);
    });
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    const results = await svc.translate(["Hello", "World"], "zh-CN");
    expect(results).toEqual(["Hello", "译World"]);
    // 免费通道端点只收原文，system 指令不进请求（端点也不解析）
    for (const c of calls) {
      const q = new URL(c.url).searchParams.get("q") ?? "";
      expect(q).not.toContain("{{NO_TRANSLATION_NEEDED}}");
    }
  });

  it("流式单段路径同样做哨兵映射（不发批量指令）", async () => {
    mockStorage(openAiSettings());
    stubFetch(() =>
      sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: "{{NO_TRANSLATION_NEEDED}}" } }] })}\n\n`])
    );
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    const deltas: string[] = [];
    const result = await svc.translateStream("Hello world", "zh-CN", (d) => deltas.push(d));
    expect(result).toBe("Hello world");
  });
});

describe("自定义翻译 prompt（api.customSystemPrompt）", () => {
  it("非空时拼在系统提示词最前；批量协议指令完整保留在其后（哨兵模式）", async () => {
    mockStorage(
      openAiSettings({
        api: { batchMode: "separator", customSystemPrompt: "保持术语一致，使用书面语。" },
      })
    );
    const { calls } = stubFetch(() =>
      jsonResponse({ choices: [{ message: { content: "一\n===IT_SEP===\n二" } }] })
    );
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    const results = await svc.translate(["aaa", "bbb"], "zh-CN");
    expect(results).toEqual(["一", "二"]);
    const body = JSON.parse(calls[0].init.body as string);
    const system = body.messages[0].content as string;
    // 附加指令在最前，其后是原有系统提示词与批量分段规则（协议段完整保留）
    expect(system.startsWith("保持术语一致，使用书面语。\n\n你是专业翻译引擎")).toBe(true);
    expect(system).toContain("===IT_SEP===");
    expect(system).toContain("批量分段规则");
    expect(body.messages[1].content).toBe("aaa\n===IT_SEP===\nbbb");
  });

  it("逐行协议下同样保留逐行指令；单段请求（划词流式）也拼附加指令", async () => {
    mockStorage(openAiSettings({ api: { customSystemPrompt: "不要翻译代码块。" } }));
    const { calls } = stubFetch(() =>
      jsonResponse({ choices: [{ message: { content: "第一\n第二" } }] })
    );
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    await svc.translate(["aaa", "bbb"], "zh-CN");
    const batchBody = JSON.parse(calls[0].init.body as string);
    expect(batchBody.messages[0].content.startsWith("不要翻译代码块。\n\n你是专业翻译引擎")).toBe(true);
    expect(batchBody.messages[1].content).toContain("请逐行翻译以下内容");

    await svc.translateStream("hello", "zh-CN", () => undefined);
    const streamBody = JSON.parse(calls[calls.length - 1].init.body as string);
    expect(streamBody.messages[0].content.startsWith("不要翻译代码块。\n\n你是专业翻译引擎")).toBe(true);
  });

  it("缺省（旧版设置无该字段）→ 单段系统提示词与历史版本逐字一致", async () => {
    mockStorage(openAiSettings());
    const { calls } = stubFetch(() => jsonResponse({ choices: [{ message: { content: "译文" } }] }));
    const { TranslateService } = await import("../src/background/translate");
    const svc = new TranslateService();
    await svc.translate(["hello"], "zh-CN");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.messages[0].content).toBe(
      "你是专业翻译引擎。将用户输入翻译为zh-CN，只输出译文，不要解释、不要添加任何额外内容。"
    );
  });
});

describe("内容侧 translateTextStream：Port 客户端", () => {
  /** 伪 Port：模拟 chrome.runtime.connect 的对端（background）行为 */
  function fakePort() {
    const messageListeners: Array<(m: unknown) => void> = [];
    const disconnectListeners: Array<() => void> = [];
    const port = {
      name: "it-stream",
      onMessage: { addListener: (f: (m: unknown) => void) => messageListeners.push(f) },
      onDisconnect: { addListener: (f: () => void) => disconnectListeners.push(f) },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { connect: vi.fn(() => port) },
    } as unknown as typeof chrome;
    return {
      port,
      emit: (m: unknown) => messageListeners.forEach((f) => f(m)),
      close: () => disconnectListeners.forEach((f) => f()),
    };
  }

  it("增量回调 + done 以完整译文 resolve；start 消息携带术语占位后的文本", async () => {
    const { port, emit } = fakePort();
    const deltas: string[] = [];
    const handle = translateTextStream("AI is great", "zh-CN", ["AI"], (d) => deltas.push(d));
    // 术语表占位：AI → ⟦0⟧（与整页翻译同协议）
    expect((port.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      type: "stream-start",
      text: "⟦0⟧ is great",
      targetLang: "zh-CN",
    });
    emit({ type: "stream-delta", delta: "⟦0⟧" });
    emit({ type: "stream-delta", delta: "很棒" });
    emit({ type: "stream-done", text: "⟦0⟧很棒" });
    await expect(handle.promise).resolves.toBe("AI很棒"); // done 时统一还原术语
    expect(deltas).toEqual(["⟦0⟧", "很棒"]);
  });

  it("stream-error → reject TranslateError（带错误类型/诊断）", async () => {
    const { emit } = fakePort();
    const handle = translateTextStream("hello", "zh-CN", [], () => undefined);
    emit({
      type: "stream-error",
      error: "主 API 鉴权失败",
      errorCode: "auth",
      diagnostic: { provider: "openai", endpoint: "https://x", hostname: "x" },
    });
    await expect(handle.promise).rejects.toBeInstanceOf(TranslateError);
  });

  it("未收到 done/error 就断连 → reject；已终结后 cancel() 幂等不抛错", async () => {
    const { close } = fakePort();
    const handle = translateTextStream("hello", "zh-CN", [], () => undefined);
    close();
    await expect(handle.promise).rejects.toThrow("翻译连接已断开");
    expect(() => handle.cancel()).not.toThrow(); // 已 settle：无需再断连
  });

  it("在途时 cancel() → promise 以取消终结（await 方不悬挂）", async () => {
    const { port } = fakePort();
    const handle = translateTextStream("hello", "zh-CN", [], () => undefined);
    handle.cancel();
    await expect(handle.promise).rejects.toThrow("cancelled");
    expect(port.disconnect).toHaveBeenCalled();
  });
});
