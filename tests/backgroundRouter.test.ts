/**
 * background/index.ts 消息路由黑盒回归（审查结论 D8：SW 入口此前零直接测试）。
 * 内容侧测试全部 mock 背景响应，本文件把 onMessage 路由器当黑盒：
 *  - vi.mock 掉 translate / keepAlive / sessionRegistry / edgeTts / ttsPlayback /
 *    providers / shared/storage 等下游模块，只测「路由分发 + 回包结构」，不测下游逻辑；
 *  - 每条用例钉住一个可变异点：消息 type 字符串、回包形状（ok/results/error/errorCode/
 *    cachedCount/count/removed/finished）、cancelled 归一化、未知消息不回包、
 *    keepAlive 在请求前后成对调用、Port 流式网关的 delta/done/error 转发。
 * keepAlive 模块整体被 mock，不会产生真实定时器，因此无需 fake timers。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { STREAM_PORT_NAME } from "../src/shared/messages";
import { ApiError } from "../src/background/providers/http";
// 运行时取到的是下方 vi.mock 工厂里的同名类（与 index.ts instanceof 的是同一个），
// 类型来自真实模块声明，仅用于构造被路由器识别的取消错误。
import { TranslationCancelledError } from "../src/background/translate";

// ===== 下游模块 mock（vi.hoisted 保证工厂可引用） =====

const h = vi.hoisted(() => ({
  translate: vi.fn(),
  clearCache: vi.fn(),
  checkCache: vi.fn(),
  cacheStats: vi.fn(),
  cleanupCache: vi.fn(),
  generatePageSummary: vi.fn(),
  translateStream: vi.fn(),
  beginKeepAlive: vi.fn(),
  endKeepAlive: vi.fn(),
  registerSessionController: vi.fn(),
  unregisterSessionController: vi.fn(),
  abortSession: vi.fn(),
  synthesizeSpeech: vi.fn(),
  ttsPlay: vi.fn(),
  ttsStop: vi.fn(),
  getSettings: vi.fn(),
  createProvider: vi.fn(),
}));

vi.mock("../src/background/translate", () => {
  class TranslationCancelledError extends Error {
    constructor() {
      super("翻译已取消");
      this.name = "TranslationCancelledError";
    }
  }
  class TranslateService {
    translate = h.translate;
    clearCache = h.clearCache;
    checkCache = h.checkCache;
    cacheStats = h.cacheStats;
    cleanupCache = h.cleanupCache;
    generatePageSummary = h.generatePageSummary;
    translateStream = h.translateStream;
  }
  return { TranslateService, TranslationCancelledError };
});
vi.mock("../src/background/keepAlive", () => ({
  beginKeepAlive: h.beginKeepAlive,
  endKeepAlive: h.endKeepAlive,
}));
vi.mock("../src/background/sessionRegistry", () => ({
  registerSessionController: h.registerSessionController,
  unregisterSessionController: h.unregisterSessionController,
  abortSession: h.abortSession,
}));
vi.mock("../src/background/edgeTts", () => ({ synthesizeSpeech: h.synthesizeSpeech }));
vi.mock("../src/background/ttsPlayback", () => ({ ttsPlay: h.ttsPlay, ttsStop: h.ttsStop }));
vi.mock("../src/shared/storage", () => ({ getSettings: h.getSettings }));
vi.mock("../src/background/providers", () => ({ createProvider: h.createProvider }));

// ===== chrome 事件桩：捕获 onMessage / onConnect 监听器 =====

const onMessageAdd: Mock = vi.fn();
const onConnectAdd: Mock = vi.fn();

type SendResponseFn = (response?: unknown) => void;
type OnMessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: SendResponseFn
) => boolean | undefined;

const SENDER = { tab: { id: 7 }, frameId: 2 } as chrome.runtime.MessageSender;

let messageListener: OnMessageListener;
let connectListener: (port: unknown) => void;

beforeAll(async () => {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: { addListener: onMessageAdd },
      onConnect: { addListener: onConnectAdd },
    },
    alarms: { onAlarm: { addListener: vi.fn() }, create: vi.fn() },
    commands: { onCommand: { addListener: vi.fn() } },
  } as unknown as typeof chrome;
  // 动态 import 触发 addListener 注册（模块只在本文件加载，隔离于其他测试文件）
  await import("../src/background/index");
  messageListener = onMessageAdd.mock.calls[0][0] as OnMessageListener;
  connectListener = onConnectAdd.mock.calls[0][0] as (port: unknown) => void;
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
  vi.restoreAllMocks();
});

/** 派发一条 onMessage 消息；sendResponse 默认为全新的 spy */
function dispatch(
  message: unknown,
  sendResponse: SendResponseFn = vi.fn()
): { ret: boolean | undefined; sendResponse: SendResponseFn } {
  const ret = messageListener(message, SENDER, sendResponse);
  return { ret, sendResponse };
}

const TRANSLATE_REQ = { type: "translate", id: "t-1", texts: ["hello", "world"], targetLang: "zh-CN" };

// ===== translate 路由 =====

describe("onMessage 路由：translate", () => {
  it("translate 消息 → 调用翻译服务，回包 { id, ok: true, results }，异步通道 return true", async () => {
    h.translate.mockResolvedValue(["你好", "世界"]);
    const { ret, sendResponse } = dispatch(TRANSLATE_REQ);
    // 返回 true：sendResponse 通道保持开放（MV3 异步回包的前提）
    expect(ret).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(sendResponse).toHaveBeenCalledWith({ id: "t-1", ok: true, results: ["你好", "世界"] });
    expect(h.translate).toHaveBeenCalledWith(
      ["hello", "world"],
      "zh-CN",
      undefined,
      expect.any(AbortSignal)
    );
  });

  it("translate 失败 → 回包 { id, ok: false, error }（普通错误不带 errorCode）", async () => {
    h.translate.mockRejectedValue(new Error("网络故障"));
    const { sendResponse } = dispatch({ ...TRANSLATE_REQ, id: "t-2" });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(sendResponse).toHaveBeenCalledWith({ id: "t-2", ok: false, error: "网络故障" });
  });

  it("translate 失败（ApiError）→ errorCode 透传，供工具条区分错误类型", async () => {
    h.translate.mockRejectedValue(new ApiError("rate_limit", "432 已限流"));
    const { sendResponse } = dispatch({ ...TRANSLATE_REQ, id: "t-3" });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t-3", ok: false, error: "432 已限流", errorCode: "rate_limit" })
    );
  });

  it("translate 被取消（TranslationCancelledError）→ error 归一化为 \"cancelled\"", async () => {
    h.translate.mockRejectedValue(new TranslationCancelledError());
    const { sendResponse } = dispatch({ ...TRANSLATE_REQ, id: "t-4" });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(sendResponse).toHaveBeenCalledWith({ id: "t-4", ok: false, error: "cancelled" });
  });

  it("translate 成功路径 beginKeepAlive/endKeepAlive 成对调用（会话控制器随请求注册/摘除）", async () => {
    h.translate.mockResolvedValue(["ok"]);
    dispatch({ ...TRANSLATE_REQ, id: "t-ka" });
    await vi.waitFor(() => expect(h.endKeepAlive).toHaveBeenCalledTimes(1));
    expect(h.beginKeepAlive).toHaveBeenCalledTimes(1);
    expect(h.endKeepAlive).toHaveBeenCalledTimes(1);
    expect(h.registerSessionController).toHaveBeenCalledTimes(1);
    expect(h.unregisterSessionController).toHaveBeenCalledTimes(1);
  });
});

// ===== 其余消息类型 =====

describe("onMessage 路由：其余消息类型", () => {
  it("未知消息类型 → 不调用任何 handler，也不回包（返回 undefined）", () => {
    const { ret, sendResponse } = dispatch({ type: "no-such-type" });
    const { ret: ret2, sendResponse: sendResponse2 } = dispatch(null);
    expect(ret).toBeUndefined();
    expect(ret2).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
    expect(sendResponse2).not.toHaveBeenCalled();
    for (const fn of [
      h.translate,
      h.clearCache,
      h.checkCache,
      h.cacheStats,
      h.cleanupCache,
      h.generatePageSummary,
      h.synthesizeSpeech,
      h.ttsPlay,
      h.ttsStop,
      h.createProvider,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("clear-cache → 调用 clearCache 并回包 { ok: true }", async () => {
    h.clearCache.mockResolvedValue(undefined);
    const { ret, sendResponse } = dispatch({ type: "clear-cache" });
    expect(ret).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(h.clearCache).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("cache-stats → 调用 cacheStats 并回包 { count }", async () => {
    h.cacheStats.mockResolvedValue(42);
    const { ret, sendResponse } = dispatch({ type: "cache-stats" });
    expect(ret).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(h.cacheStats).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ count: 42 });
  });

  it("check-cache → 透传目标语言与文本，回包 { cachedCount }", async () => {
    h.checkCache.mockResolvedValue(3);
    const { ret, sendResponse } = dispatch({
      type: "check-cache",
      targetLang: "zh-CN",
      texts: ["a", "b", "c", "d"],
    });
    expect(ret).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(h.checkCache).toHaveBeenCalledWith("zh-CN", ["a", "b", "c", "d"]);
    expect(sendResponse).toHaveBeenCalledWith({ cachedCount: 3 });
  });

  it("cleanup-cache → 调用 cleanupCache 并回包 { ok: true, removed }", async () => {
    h.cleanupCache.mockResolvedValue(5);
    const { ret, sendResponse } = dispatch({ type: "cleanup-cache" });
    expect(ret).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, removed: 5 });
  });

  it("page-summary → 调用 generatePageSummary 并回包 { id, ok, summary }，keepAlive 成对", async () => {
    h.generatePageSummary.mockResolvedValue("这是摘要");
    const { ret, sendResponse } = dispatch({
      type: "page-summary",
      id: "p-1",
      title: "标题",
      content: "正文",
      sessionId: 1,
    });
    expect(ret).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(sendResponse).toHaveBeenCalledWith({ id: "p-1", ok: true, summary: "这是摘要" });
    expect(h.generatePageSummary).toHaveBeenCalledWith("标题", "正文", expect.any(AbortSignal));
    expect(h.beginKeepAlive).toHaveBeenCalledTimes(1);
    expect(h.endKeepAlive).toHaveBeenCalledTimes(1);
  });

  it("test-connection → createProvider(...).chat，回包 { id, ok, message }（文案 trim）", async () => {
    const chat = vi.fn(async () => ({ text: "  连接成功  " }));
    h.createProvider.mockReturnValue({ chat });
    const api = {
      format: "openai" as const,
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
      model: "m",
      temperature: 0.3,
      timeoutMs: 60000,
      maxConcurrency: 3,
    };
    const { ret, sendResponse } = dispatch({ type: "test-connection", id: "c-1", api });
    expect(ret).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(h.createProvider).toHaveBeenCalledWith(api);
    expect(sendResponse).toHaveBeenCalledWith({ id: "c-1", ok: true, message: "连接成功" });
  });

  it("test-connection 失败（ApiError）→ 回包 { id, ok: false, error, errorCode }", async () => {
    const chat = vi.fn(async () => {
      throw new ApiError("auth", "401 未授权");
    });
    h.createProvider.mockReturnValue({ chat });
    const { sendResponse } = dispatch({
      type: "test-connection",
      id: "c-2",
      api: { format: "openai", baseUrl: "https://x.test", apiKey: "k", model: "m", temperature: 0, timeoutMs: 60000, maxConcurrency: 1 },
    });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c-2", ok: false, error: "401 未授权", errorCode: "auth" })
    );
  });

  it("tts-synthesize → 按设置解析声音/语速合成，回包 { id, ok, audioBase64, contentType }，keepAlive 成对", async () => {
    h.getSettings.mockResolvedValue({ tts: { voice: "my-voice", rate: 20 } });
    h.synthesizeSpeech.mockResolvedValue({ audioBase64: "QUJD", contentType: "audio/mpeg" });
    const { ret, sendResponse } = dispatch({
      type: "tts-synthesize",
      id: "s-1",
      text: "你好",
      targetLang: "zh-CN",
    });
    expect(ret).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(h.synthesizeSpeech).toHaveBeenCalledWith("你好", "zh-CN", {
      userVoice: "my-voice",
      rate: 20,
    });
    expect(sendResponse).toHaveBeenCalledWith({
      id: "s-1",
      ok: true,
      audioBase64: "QUJD",
      contentType: "audio/mpeg",
    });
    expect(h.beginKeepAlive).toHaveBeenCalledTimes(1);
    expect(h.endKeepAlive).toHaveBeenCalledTimes(1);
  });

  it("tts-play → 转发 offscreen 播放并回包 { id, ok, finished }", async () => {
    h.ttsPlay.mockResolvedValue({ finished: true });
    const msg = { type: "tts-play", id: "y-1", requestId: "r1", audioBase64: "QUJD", contentType: "audio/mpeg" };
    const { ret, sendResponse } = dispatch(msg);
    expect(ret).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(h.ttsPlay).toHaveBeenCalledWith(msg);
    expect(sendResponse).toHaveBeenCalledWith({ id: "y-1", ok: true, finished: true });
  });

  it("tts-stop → 回包 { ok: true }；底层失败同样静默成功（无在途播放为 no-op）", async () => {
    h.ttsStop.mockRejectedValue(new Error("offscreen 不存在"));
    const { ret, sendResponse } = dispatch({ type: "tts-stop" });
    expect(ret).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("cancel-translation → 按发送方中止会话，不同步回包（返回 false）", () => {
    const { ret, sendResponse } = dispatch({ type: "cancel-translation", sessionId: 3 });
    expect(ret).toBe(false);
    expect(h.abortSession).toHaveBeenCalledWith(SENDER, 3);
    expect(sendResponse).not.toHaveBeenCalled();
  });
});

// ===== 划词流式 Port 网关 =====

function makePort(name: string): {
  port: {
    name: string;
    postMessage: Mock;
    disconnect: Mock;
    onMessage: { addListener: Mock };
    onDisconnect: { addListener: Mock };
  };
  onMessage: (raw: unknown) => void;
  onDisconnect: () => void;
} {
  const state: { onMessage?: (raw: unknown) => void; onDisconnect?: () => void } = {};
  const port = {
    name,
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener: vi.fn((fn: (raw: unknown) => void) => {
        state.onMessage = fn;
      }),
    },
    onDisconnect: {
      addListener: vi.fn((fn: () => void) => {
        state.onDisconnect = fn;
      }),
    },
  };
  return {
    port,
    onMessage: (raw: unknown) => state.onMessage?.(raw),
    onDisconnect: () => state.onDisconnect?.(),
  };
}

describe("划词流式 Port 网关", () => {
  it("stream-start → 转发增量与 stream-done，结束断开 Port，keepAlive 成对，重复 start 忽略", async () => {
    h.translateStream.mockImplementation(
      (_text: string, _lang: string, onDelta: (d: string) => void) => {
        onDelta("你");
        onDelta("好");
        return Promise.resolve("你好");
      }
    );
    const { port, onMessage } = makePort(STREAM_PORT_NAME);
    connectListener(port);
    expect(port.onMessage.addListener).toHaveBeenCalledTimes(1);
    onMessage({ type: "stream-start", text: "hello", targetLang: "zh-CN" });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledWith({ type: "stream-done", text: "你好" }));
    expect(port.postMessage).toHaveBeenCalledWith({ type: "stream-delta", delta: "你" });
    expect(port.postMessage).toHaveBeenCalledWith({ type: "stream-delta", delta: "好" });
    expect(port.disconnect).toHaveBeenCalledTimes(1);
    expect(h.beginKeepAlive).toHaveBeenCalledTimes(1);
    expect(h.endKeepAlive).toHaveBeenCalledTimes(1);
    // 只认首条 start：重复消息忽略，不重复发起翻译
    onMessage({ type: "stream-start", text: "again", targetLang: "zh-CN" });
    expect(h.translateStream).toHaveBeenCalledTimes(1);
    expect(port.postMessage).toHaveBeenCalledTimes(3);
  });

  it("流失败 → postMessage stream-error（普通错误不带 errorCode），Port 断开", async () => {
    h.translateStream.mockRejectedValue(new Error("流失败"));
    const { port, onMessage } = makePort(STREAM_PORT_NAME);
    connectListener(port);
    onMessage({ type: "stream-start", text: "hello", targetLang: "zh-CN" });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(1));
    expect(port.postMessage).toHaveBeenCalledWith({ type: "stream-error", error: "流失败" });
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });

  it("流被取消（TranslationCancelledError）→ 静默结束，不回 stream-error", async () => {
    h.translateStream.mockRejectedValue(new TranslationCancelledError());
    const { port, onMessage } = makePort(STREAM_PORT_NAME);
    connectListener(port);
    onMessage({ type: "stream-start", text: "hello", targetLang: "zh-CN" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(port.disconnect).not.toHaveBeenCalled();
  });

  it("非流式 Port 名 → 不注册消息监听（网关只服务 it-stream）", () => {
    const { port } = makePort("other-port");
    connectListener(port);
    expect(port.onMessage.addListener).not.toHaveBeenCalled();
  });
});
