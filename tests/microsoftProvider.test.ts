/**
 * Microsoft 免 key 通道回归测试：
 * - 请求形状固定：edge.microsoft.com/translate/translatetext，POST 裸 JSON 字符串数组；
 * - 语言码归一化（zh-CN → zh-Hans / zh-TW → zh-Hant）；
 * - 正文含 < > & 时转义发送、返回解码一次（端点会跑 HTML 标签对齐器）；
 * - 429 归类 rate_limit；
 * - 免费通道互切：googlefree 429 耗尽重试后自动切 microsoft（未配置备用 API 时）；
 * - 超时按字符数缩放（封顶 120s）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { uninstallChromeMock } from "./helpers/chromeMock";
import { microsoftProvider } from "../src/background/providers/microsoft";
import { freeSiblingApi, scaleTimeoutMs, TranslateService } from "../src/background/translate";
import type { ChatMessage, ChatOptions } from "../src/background/providers/types";
import type { Settings } from "../src/shared/types";

const SEP = "===IT_SEP===";

const BASE_OPTS: ChatOptions = {
  baseUrl: "",
  apiKey: "",
  model: "",
  temperature: 0,
  timeoutMs: 5000,
  batchMode: "separator",
  batchSeparator: SEP,
  targetLang: "zh-CN",
};

function freeSettings(format: "googlefree" | "microsoft", backup?: Settings["backupApi"]): Settings {
  return {
    version: 4,
    enabled: true,
    api: {
      format,
      baseUrl: "",
      apiKey: "",
      model: "",
      temperature: 0.3,
      timeoutMs: 60000,
      maxConcurrency: 2,
    },
    ...(backup ? { backupApi: backup } : {}),
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

function mockStorageFor(settings: Settings): void {
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: unknown) => (key === "settings" ? { settings } : {})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    },
  } as unknown as typeof chrome;
}

/** 微软成功响应：与请求等长的 [{ translations: [{ text }] }] */
function microsoftOk(texts: string[]): Response {
  return new Response(
    JSON.stringify(texts.map((t) => ({ translations: [{ text: `M:${t}` }] }))),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("microsoftProvider 请求形状", () => {
  afterEach(() => {
    uninstallChromeMock();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("单段：POST 裸 JSON 字符串数组到 edge.microsoft.com，from 为空", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      microsoftOk(["hello"])
    );
    vi.stubGlobal("fetch", fetchMock);
    const messages: ChatMessage[] = [
      { role: "system", content: "你是专业翻译引擎。将用户输入翻译为zh-CN，只输出译文。" },
      { role: "user", content: "hello" },
    ];
    const result = await microsoftProvider.chat(messages, { ...BASE_OPTS, batchSize: 1 });
    expect(result.text).toBe("M:hello");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://edge.microsoft.com/translate/translatetext");
    expect(parsed.searchParams.get("from")).toBe("");
    expect(parsed.searchParams.get("to")).toBe("zh-Hans");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(["hello"]);
  });

  it("批量：多段一次请求携带，输出按哨兵拼回", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      microsoftOk(JSON.parse(String(init?.body)) as string[])
    );
    vi.stubGlobal("fetch", fetchMock);
    const messages: ChatMessage[] = [
      { role: "system", content: "你是专业翻译引擎。将用户输入翻译为zh-CN，只输出译文。" },
      { role: "user", content: ["hello", "world"].join(`\n${SEP}\n`) },
    ];
    const result = await microsoftProvider.chat(messages, { ...BASE_OPTS, batchSize: 2 });
    expect(result.text).toBe(`M:hello\n${SEP}\nM:world`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(["hello", "world"]);
  });

  it("语言码归一化：zh-TW → zh-Hant，en → en", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      microsoftOk(["x"])
    );
    vi.stubGlobal("fetch", fetchMock);
    const messages: ChatMessage[] = [
      { role: "system", content: "你是专业翻译引擎。将用户输入翻译为zh-TW，只输出译文。" },
      { role: "user", content: "x" },
    ];
    await microsoftProvider.chat(messages, { ...BASE_OPTS, targetLang: "zh-TW" });
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("to")).toBe("zh-Hant");

    const messagesEn: ChatMessage[] = [
      { role: "system", content: "translate to en" },
      { role: "user", content: "x" },
    ];
    await microsoftProvider.chat(messagesEn, { ...BASE_OPTS, targetLang: "en" });
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get("to")).toBe("en");
  });

  it("正文含 < > & 时转义发送、返回解码一次（标签对齐器保护）", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify([{ translations: [{ text: "A &lt; B &amp; C &gt; D" }] }]), {
        status: 200,
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const messages: ChatMessage[] = [
      { role: "system", content: "你是专业翻译引擎。将用户输入翻译为zh-CN，只输出译文。" },
      { role: "user", content: "a < b & c > d" },
    ];
    const result = await microsoftProvider.chat(messages, { ...BASE_OPTS, batchSize: 1 });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(["a &lt; b &amp; c &gt; d"]);
    expect(result.text).toBe("A < B & C > D");
  });

  it("429 归类为 rate_limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 }))
    );
    const messages: ChatMessage[] = [
      { role: "system", content: "你是专业翻译引擎。将用户输入翻译为zh-CN，只输出译文。" },
      { role: "user", content: "hello" },
    ];
    await expect(microsoftProvider.chat(messages, { ...BASE_OPTS, batchSize: 1 })).rejects.toMatchObject({
      name: "ApiError",
      code: "rate_limit",
    });
  });
});

describe("免费通道互切与超时缩放", () => {
  afterEach(() => uninstallChromeMock());

  it("freeSiblingApi：googlefree ↔ microsoft 互为备份；有备用 API 或非免费主通道时为 null", () => {
    expect(freeSiblingApi(freeSettings("googlefree"))?.format).toBe("microsoft");
    expect(freeSiblingApi(freeSettings("microsoft"))?.format).toBe("googlefree");
    const withBackup = freeSettings("googlefree", freeSettings("microsoft").api);
    expect(freeSiblingApi(withBackup)).toBeNull();
    const openaiSettings = freeSettings("googlefree");
    openaiSettings.api.format = "openai";
    expect(freeSiblingApi(openaiSettings)).toBeNull();
  });

  it("scaleTimeoutMs：base + 15ms/字符，封顶 max(base, 120s)", () => {
    expect(scaleTimeoutMs(60000, 0)).toBe(60000);
    expect(scaleTimeoutMs(60000, 1000)).toBe(75000);
    expect(scaleTimeoutMs(60000, 100000)).toBe(120000);
    expect(scaleTimeoutMs(10000, 0)).toBe(10000);
    expect(scaleTimeoutMs(10000, 10000)).toBe(120000);
  });

  it("googlefree 429 重试耗尽后自动互切到 microsoft（未配置备用 API）", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("translate.googleapis.com")) {
          return new Response("rate limited", { status: 429 });
        }
        const texts = JSON.parse(String(init?.body)) as string[];
        return microsoftOk(texts);
      });
      vi.stubGlobal("fetch", fetchMock);
      mockStorageFor(freeSettings("googlefree"));

      const svc = new TranslateService();
      const promise = svc.translate(["hello"], "zh-CN");
      await vi.runAllTimersAsync();
      expect(await promise).toEqual(["M:hello"]);
      // googlefree 4 次尝试（初始 + 3 重试）全部 429 后，第 5 次请求走 microsoft
      const googleCalls = calls.filter((u) => u.includes("translate.googleapis.com"));
      const microsoftCalls = calls.filter((u) => u.includes("edge.microsoft.com"));
      expect(googleCalls.length).toBe(4);
      expect(microsoftCalls.length).toBe(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
