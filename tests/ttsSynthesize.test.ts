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

/** 构造端点 JWT：t 为签名后缀标记，ttlSec 控制 exp（默认 600s = 正常令牌寿命） */
function makeToken(t: string, ttlSec = 600): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + ttlSec }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${payload}.sig-${t}`;
}

function tokenResponse(t: string, ttlSec = 600): Response {
  return new Response(JSON.stringify({ t: makeToken(t, ttlSec), r: "eastus" }), { status: 200 });
}

function audioResponse(): Response {
  return new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 });
}

/** 区分令牌端点与合成端点的 fetch mock，记录每次调用 */
function routeFetch(
  handler: (url: string) => Response | Promise<Response>
): ReturnType<typeof vi.fn> {
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
    const synthCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("cognitiveservices")
    );
    expect(synthCalls.length).toBe(2);
    const init = synthCalls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toContain(".sig-t1");
    expect(String(init.body)).toContain('<voice name="zh-CN-XiaoxiaoNeural">');
    // base64 音频可解回原字节
    expect(Array.from(Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0)))).toEqual([
      1, 2, 3, 4,
    ]);
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
    const tokenCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("dev.microsofttranslator")
    );
    expect(tokenCalls.length).toBe(2);
    expect(synthCalls).toBe(2);
    const retryAuth = (
      (fetchMock.mock.calls[3]?.[1] as RequestInit).headers as Record<string, string>
    )["Authorization"];
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

  it("业务错误不被超时文案吞掉（实现回归检测：把 isAbortError 放宽成 aborted 即判全部超时）", async () => {
    // withRequestTimeout 只允许在「超时先于业务错误发生」时报超时：
    // fetch 正常返回 HTTP 500 → run 抛「合成失败」，此时计时器未触发、signal 未 aborted，
    // 必须原样抛出 HTTP 错误。若实现退回「signal.aborted 即超时」的笼统判断，
    // 本用例借「计时器已清理」的时序差保证仍指向 HTTP 500 而非超时。
    const fetchMock = routeFetch((url) =>
      url.includes("dev.microsofttranslator.com")
        ? tokenResponse("t1")
        : new Response("server error", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(synthesizeSpeech("错", "zh-CN")).rejects.toThrow(/合成失败（HTTP 500）/);
  });

  it("令牌失效重发拥有独立计时窗口：重发前等待数秒也不吃掉重发自身的 30s", async () => {
    // 旧实现把首次请求与重发放在同一个 withRequestTimeout 作用域：
    // 首次请求若耗掉大半窗口后返回 401，重发只剩零头时间，可恢复的令牌失效被误报成超时。
    // 现在 401 后清缓存重取令牌 + 重发各自计时。fake timers 推进 3s 延迟（原真实 sleep 6s）。
    vi.useFakeTimers();
    try {
      let synthCalls = 0;
      let tokenCount = 0;
      const fetchMock = routeFetch(async (url) => {
        if (url.includes("dev.microsofttranslator.com")) {
          tokenCount++;
          return tokenResponse(`t${tokenCount}`);
        }
        synthCalls++;
        // 首次合成请求挂 3 秒才返回 401（老实现若共用窗口，剩余 27s 仍够——
        // 所以再把首次返回后的令牌获取也拖 3 秒，压缩共用窗口下的余量并确保语义成立）
        if (synthCalls === 1) {
          await new Promise((r) => setTimeout(r, 3000));
          return new Response("", { status: 401 });
        }
        return audioResponse();
      });
      vi.stubGlobal("fetch", fetchMock);

      const assertion = expect(synthesizeSpeech("重试", "zh-CN")).resolves.toMatchObject({
        audioBase64: expect.any(String),
      });
      // 分段推进：crypto.subtle 签名链是真实异步，3s 计时器在链路走完前尚未注册，
      // 一次推 6s 会错过中途注册点。每次推 1s 逐步覆盖「注册点 + 3s 窗口」。
      for (let i = 0; i < 7; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await assertion;
      expect(synthCalls).toBe(2);
      expect(tokenCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("合成请求挂起超过 30s 被硬超时打断（计时覆盖到响应体）", async () => {
    vi.useFakeTimers();
    try {
      // 模拟真实 fetch：signal abort 时以 AbortError 拒绝（真实浏览器行为）
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("dev.microsofttranslator.com")) return tokenResponse("t1");
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("This operation was aborted", "AbortError"))
          );
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const pending = synthesizeSpeech("挂起", "zh-CN");
      const assertion = expect(pending).rejects.toThrow(/请求超时（30000ms）/);
      // 先推 1s：等令牌签名链（crypto.subtle 真异步）走完、30s 超时计时器注册进 fake clock；
      // 再推 60s：覆盖「注册点 + 30s 窗口」。一次性推 30s 会错过中途注册的计时器。
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("令牌临近过期（< 3 分钟窗口）时下次合成重新取令牌", async () => {
    // getEndpointToken 只在 now < expiredAt - 3min 时复用缓存：
    // exp = now + 60s 的令牌一落缓存就已进入刷新窗口，第二次合成必须重新请求令牌端点。
    // 旧实现若把窗口判断写成 expiredAt - now < 0（只在真过期后刷新），本用例抓到回归。
    let tokenCount = 0;
    const fetchMock = routeFetch((url) => {
      if (url.includes("dev.microsofttranslator.com")) {
        tokenCount++;
        return tokenResponse(`t-short-${tokenCount}`, 60);
      }
      return audioResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    await synthesizeSpeech("第一条", "zh-CN");
    const firstAuth = (
      (fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>
    )["Authorization"];
    expect(firstAuth).toContain(".sig-t-short-1");

    // 第二次合成：短寿命令牌在刷新窗口内 → 令牌端点被再次请求，Authorization 换新
    await synthesizeSpeech("第二条", "zh-CN");
    const tokenCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("dev.microsofttranslator")
    );
    expect(tokenCalls.length).toBe(2);
    const synthCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("cognitiveservices")
    );
    expect(synthCalls.length).toBe(2);
    const secondAuth = (synthCalls[1]?.[1] as RequestInit).headers as Record<string, string>;
    expect(secondAuth["Authorization"]).toContain(".sig-t-short-2");
    expect(secondAuth["Authorization"]).not.toBe(firstAuth);
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

  it("熔断 15 分钟到期后自动恢复，恢复后能重新发起请求", async () => {
    // isEdgeTTSCircuitOpen(now) 按 circuitOpenUntil > now 判定：
    // 开路瞬间 + 15min 整点边界上熔断恰好关闭（实现若把比较写成 >= 则到期仍熔断，此处抓住）。
    // 所有端点都 500：5 次失败都发生在令牌端点（无可用缓存令牌），错误为「令牌获取失败」。
    vi.useFakeTimers();
    try {
      const fetchMock = routeFetch(() => new Response("server error", { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);

      for (let i = 0; i < 5; i++) {
        await expect(synthesizeSpeech("失败", "zh-CN")).rejects.toThrow(/令牌获取失败（HTTP 500）/);
      }
      expect(isEdgeTTSCircuitOpen()).toBe(true);
      const callsAtOpen = fetchMock.mock.calls.length;

      // 推进到恰好 15 分钟：熔断应关闭（边界语义）。边界前 1ms 仍应开路。
      await vi.advanceTimersByTimeAsync(CIRCUIT_OPEN_MS - 1);
      expect(isEdgeTTSCircuitOpen()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(isEdgeTTSCircuitOpen()).toBe(false);

      // 恢复后真实发请求：熔断解除后 synthesizeSpeech 不再直接抛「熔断」，
      // 而是重新请求端点（此处仍 500，错误回到 HTTP 500 而非熔断文案）
      await expect(synthesizeSpeech("恢复后重试", "zh-CN")).rejects.toThrow(/令牌获取失败（HTTP 500）/);
      expect(fetchMock.mock.calls.length).toBe(callsAtOpen + 1); // 恢复后令牌端点 1 次
    } finally {
      vi.useRealTimers();
    }
  });
});

// ===== 设置导入：tts 段逐字段校验 =====

/** 与 src/background/edgeTts.ts 的 CIRCUIT_OPEN_MS 保持一致（模块未导出） */
const CIRCUIT_OPEN_MS = 15 * 60 * 1000;

function mockStorage(): void {
  // 内存持久化：importSettings 现在先读当前设置为底再合并（P0-4），需要真实的读回
  const memory = new Map<string, unknown>();
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of list) if (memory.has(k)) out[k] = memory.get(k);
          return out;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) memory.set(k, structuredClone(v));
        }),
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

  it("合法 tts 字段导入后保留；文件未提段维持现值（无历史即默认值）", async () => {
    await importSettings({ tts: { enabled: false, voice: "en-US-BrianNeural", rate: 25 } });
    const stored = (await (
      globalThis as unknown as { chrome: { storage: { local: { set: ReturnType<typeof vi.fn> } } } }
    ).chrome.storage.local.set.mock.calls.at(-1)?.[0]) as { settings: Settings };
    expect(stored.settings.tts).toEqual({ enabled: false, voice: "en-US-BrianNeural", rate: 25 });

    // 文件没提 tts → 以当前设置为底，保留上一次导入的值（P0-4：不再静默清空）
    await importSettings({ enabled: true });
    const stored2 = (await (
      globalThis as unknown as { chrome: { storage: { local: { set: ReturnType<typeof vi.fn> } } } }
    ).chrome.storage.local.set.mock.calls.at(-1)?.[0]) as { settings: Settings };
    expect(stored2.settings.tts).toEqual({ enabled: false, voice: "en-US-BrianNeural", rate: 25 });
    expect(stored2.settings.enabled).toBe(true);
  });

  it("拒绝不含任何设置段的文件（误选 package.json 等）", async () => {
    await expect(importSettings({})).rejects.toThrow("未找到任何可识别的设置段");
    await expect(
      importSettings({ name: "some-package", version: "1.0.0", dependencies: {} })
    ).rejects.toThrow("未找到任何可识别的设置段");
  });

  it("类型错乱字段剔除回退默认", async () => {
    await importSettings({ tts: { enabled: "yes", voice: 123, rate: "fast" } });
    const stored = (await (
      globalThis as unknown as { chrome: { storage: { local: { set: ReturnType<typeof vi.fn> } } } }
    ).chrome.storage.local.set.mock.calls.at(-1)?.[0]) as { settings: Settings };
    expect(stored.settings.tts).toEqual({ enabled: true, voice: "", rate: 0 });
  });
});
