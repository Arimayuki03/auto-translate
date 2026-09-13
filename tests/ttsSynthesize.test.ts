/**
 * 划词朗读（TTS）回归测试：
 * - 声音解析：显式指定 > 目标语言精确匹配 > 语言前缀匹配 > 默认；
 * - SSML 构造：voice/locale/rate、XML 转义、控制字符清理、空文本拒绝；
 * - 合成请求形状：HMAC 签名换令牌 → 区域端点 POST SSML（Authorization 头），令牌缓存复用；
 * - 401/403 清令牌重取重试一次；空音频报错；
 * - 熔断：窗口内 5 次失败后开路，开路期间不再发请求；
 * - 设置导入：tts 段逐字段校验（enabled/voice/rate）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSSML,
  isEdgeTTSCircuitOpen,
  clearEdgeTTSTokenCache,
  resolveTtsVoice,
  resetEdgeTTSCircuitBreaker,
  synthesizeSpeech,
  TTS_MAX_TEXT_CHARS,
} from "../src/background/edgeTts";
import { importSettings } from "../src/shared/storage";
import type { Settings } from "../src/shared/types";

function makeToken(t: string): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600 }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${payload}.sig-${t}`;
}

function tokenResponse(t: string): Response {
  return new Response(JSON.stringify({ t: makeToken(t), r: "eastus" }), { status: 200 });
}

function audioResponse(): Response {
  return new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 });
}

/** 区分令牌端点与合成端点的 fetch mock，记录每次调用 */
function routeFetch(handler: (url: string) => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
}

beforeEach(() => {
  resetEdgeTTSCircuitBreaker();
  clearEdgeTTSTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveTtsVoice 声音解析", () => {
  it("精确匹配目标语言", () => {
    expect(resolveTtsVoice("zh-CN", "")).toBe("zh-CN-XiaoxiaoNeural");
    expect(resolveTtsVoice("en", "")).toBe("en-US-AvaNeural");
    expect(resolveTtsVoice("ja", "")).toBe("ja-JP-NanamiNeural");
    expect(resolveTtsVoice("ko", "")).toBe("ko-KR-SunHiNeural");
  });

  it("语言前缀匹配：en-GB → en 通道", () => {
    expect(resolveTtsVoice("en-GB", "")).toBe("en-US-AvaNeural");
    expect(resolveTtsVoice("pt-PT", "")).toBe("pt-BR-FranciscaNeural");
  });

  it("用户显式声音优先于自动映射", () => {
    expect(resolveTtsVoice("zh-CN", "en-US-BrianNeural")).toBe("en-US-BrianNeural");
  });

  it("未知语言回退默认声音", () => {
    expect(resolveTtsVoice("xx-YY", "")).toBe("en-US-AvaNeural");
    expect(resolveTtsVoice("", "")).toBe("en-US-AvaNeural");
  });
});

describe("buildSSML 构造", () => {
  it("voice/locale/rate 正确注入，正常语速输出 +0%", () => {
    const ssml = buildSSML("你好", "zh-CN-XiaoxiaoNeural", 0);
    expect(ssml).toContain('xml:lang="zh-CN"');
    expect(ssml).toContain('<voice name="zh-CN-XiaoxiaoNeural">');
    expect(ssml).toContain('rate="+0%"');
    expect(ssml).toContain(">你好</prosody>");
  });

  it("负语速原样输出负号；正语速带 + 号", () => {
    expect(buildSSML("x", "en-US-AvaNeural", -50)).toContain('rate="-50%"');
    expect(buildSSML("x", "en-US-AvaNeural", 25)).toContain('rate="+25%"');
    // 超范围钳制
    expect(buildSSML("x", "en-US-AvaNeural", 500)).toContain('rate="+100%"');
  });

  it("XML 特殊字符转义；控制字符与换行折叠为空格", () => {
    expect(buildSSML("a<b>&c", "en-US-AvaNeural", 0)).toContain("a&lt;b&gt;&amp;c");
    expect(buildSSML("a\u0001b\nc", "en-US-AvaNeural", 0)).toContain(">a b c<");
  });

  it("空白文本拒绝", () => {
    expect(() => buildSSML("   ", "en-US-AvaNeural", 0)).toThrow();
  });
});

describe("synthesizeSpeech 合成请求", () => {
  it("先换令牌再 POST SSML 到区域端点，Authorization 用令牌本体", async () => {
    const fetchMock = routeFetch((url) =>
      url.includes("dev.microsofttranslator.com") ? tokenResponse("t1") : audioResponse()
    );
    vi.stubGlobal("fetch", fetchMock);

    const { audioBase64 } = await synthesizeSpeech("你好世界", "zh-CN");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const synthUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(synthUrl).toBe("https://eastus.tts.speech.microsoft.com/cognitiveservices/v1");

    // 二次调用复用缓存的令牌：不再请求令牌端点
    await synthesizeSpeech("第二条", "zh-CN");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const synthCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("cognitiveservices"));
    expect(synthCalls.length).toBe(2);
    const init = synthCalls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toContain(".sig-t1");
    expect(String(init.body)).toContain("<voice name=\"zh-CN-XiaoxiaoNeural\">");
    // base64 音频可解回原字节
    expect(Array.from(Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0)))).toEqual([1, 2, 3, 4]);
  });

  it("超长文本截断到 TTS_MAX_TEXT_CHARS", async () => {
    const fetchMock = routeFetch((url) =>
      url.includes("dev.microsofttranslator.com") ? tokenResponse("t1") : audioResponse()
    );
    vi.stubGlobal("fetch", fetchMock);
    await synthesizeSpeech("字".repeat(TTS_MAX_TEXT_CHARS + 500), "zh-CN");
    const body = String((fetchMock.mock.calls[1]?.[1] as RequestInit).body);
    expect(body).toContain(`>${"字".repeat(TTS_MAX_TEXT_CHARS)}<`);
  });

  it("401 清令牌重取并重试一次", async () => {
    let synthCalls = 0;
    let tokenCount = 0;
    const fetchMock = routeFetch((url) => {
      if (url.includes("dev.microsofttranslator.com")) {
        tokenCount++;
        return tokenResponse(`t${tokenCount}`);
      }
      synthCalls++;
      return synthCalls === 1 ? new Response("", { status: 401 }) : audioResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await synthesizeSpeech("重试", "zh-CN");
    expect(res.audioBase64.length).toBeGreaterThan(0);
    // 令牌端点 2 次（重取）+ 合成端点 2 次（首次 401 + 重试成功）
    const tokenCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("dev.microsofttranslator"));
    expect(tokenCalls.length).toBe(2);
    expect(synthCalls).toBe(2);
    const retryAuth = ((fetchMock.mock.calls[3]?.[1] as RequestInit).headers as Record<string, string>)[
      "Authorization"
    ];
    expect(retryAuth).toContain(".sig-t2");
  });

  it("空音频报错（声音不支持该语言等）", async () => {
    const fetchMock = routeFetch((url) =>
      url.includes("dev.microsofttranslator.com")
        ? tokenResponse("t1")
        : new Response(new Uint8Array(0).buffer, { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(synthesizeSpeech("空", "zh-CN")).rejects.toThrow(/空音频/);
  });
});

describe("TTS 熔断", () => {
  it("连续 5 次失败后开路，开路期间不再发请求", async () => {
    const fetchMock = routeFetch(() => new Response("server error", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < 5; i++) {
      await expect(synthesizeSpeech("失败", "zh-CN")).rejects.toThrow();
    }
    const callsBefore = fetchMock.mock.calls.length;
    expect(isEdgeTTSCircuitOpen()).toBe(true);
    await expect(synthesizeSpeech("仍被熔断", "zh-CN")).rejects.toThrow(/熔断/);
    expect(fetchMock.mock.calls.length).toBe(callsBefore); // 熔断期零请求
  });

  it("成功后清零失败计数", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch((url) =>
        url.includes("dev.microsofttranslator.com") ? tokenResponse("t1") : audioResponse()
      )
    );
    await synthesizeSpeech("成功", "zh-CN");
    expect(isEdgeTTSCircuitOpen()).toBe(false);
  });
});

// ===== 设置导入：tts 段逐字段校验 =====

function mockStorage(): void {
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    },
  } as unknown as typeof chrome;
}

describe("importSettings 的 tts 段校验", () => {
  beforeEach(() => mockStorage());
  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
  });

  it("合法 tts 字段导入后保留；缺失字段回退默认值", async () => {
    await importSettings({ tts: { enabled: false, voice: "en-US-BrianNeural", rate: 25 } });
    const stored = await (globalThis as { chrome: { storage: { local: { set: ReturnType<typeof vi.fn> } } } })
      .chrome.storage.local.set.mock.calls.at(-1)?.[0] as { settings: Settings };
    expect(stored.settings.tts).toEqual({ enabled: false, voice: "en-US-BrianNeural", rate: 25 });

    // 整段缺失 → 默认值
    await importSettings({});
    const stored2 = await (globalThis as { chrome: { storage: { local: { set: ReturnType<typeof vi.fn> } } } })
      .chrome.storage.local.set.mock.calls.at(-1)?.[0] as { settings: Settings };
    expect(stored2.settings.tts).toEqual({ enabled: true, voice: "", rate: 0 });
  });

  it("类型错乱字段剔除回退默认", async () => {
    await importSettings({ tts: { enabled: "yes", voice: 123, rate: "fast" } });
    const stored = await (globalThis as { chrome: { storage: { local: { set: ReturnType<typeof vi.fn> } } } })
      .chrome.storage.local.set.mock.calls.at(-1)?.[0] as { settings: Settings };
    expect(stored.settings.tts).toEqual({ enabled: true, voice: "", rate: 0 });
  });
});
