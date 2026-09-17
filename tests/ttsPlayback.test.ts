/**
 * TTS 播放转发（ttsPlayback）单元测试：
 * - offscreen 文档按需创建：不存在才 createDocument，并发请求共享同一次创建；
 * - 「已存在」类重复创建报错吞掉视为成功；其他创建错误上抛；
 * - 播放成功转发消息形状（type/requestId/audioBase64/contentType）并返回 finished；
 * - 播放报错时抛出（含 error 字段文案）；
 * - offscreen 被浏览器回收（Receiving end does not exist）→ 重建后重试一次；
 * - 两次都失败则上抛；finally 中 endKeepAlive 保底执行；
 * - ttsStop 转发停止消息，接收端不存在时静默 no-op。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TtsPlayMessage } from "../src/shared/messages";

// 保活计数改用 spy 观察：验证 begin/end 严格配对（含抛错路径），
// 删掉源码 finally { endKeepAlive() } 会留下引用计数泄漏 → 对应用例红。
// 固定同一对函数实例（vi.mock 工厂结果跨 resetModules 复用，用例内自行清零计数）。
const beginKeepAliveSpy = vi.fn();
const endKeepAliveSpy = vi.fn();
vi.mock("../src/background/keepAlive", () => ({
  beginKeepAlive: beginKeepAliveSpy,
  endKeepAlive: endKeepAliveSpy,
}));

type SendMessageMock = ReturnType<typeof vi.fn>;

function makePlayReq(): TtsPlayMessage {
  return {
    type: "tts-play",
    id: "seg-1",
    requestId: "req-1",
    audioBase64: "AAAA",
    contentType: "audio/mp3",
  };
}

function installChrome(opts: {
  sendMessage: SendMessageMock;
  contexts?: unknown[];
  getContexts?: boolean;
  createDocument?: (opts: unknown) => Promise<void>;
}): void {
  const chromeObj = {
    runtime: {
      ...(opts.getContexts === false
        ? {}
        : {
            getContexts: vi.fn(async () => opts.contexts ?? []),
          }),
      ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
      sendMessage: opts.sendMessage,
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    offscreen: {
      createDocument: opts.createDocument ?? vi.fn(async () => undefined),
      Reason: { AUDIO_PLAYBACK: "AUDIO_PLAYBACK" },
    },
  };
  (globalThis as { chrome?: unknown }).chrome = chromeObj as unknown as typeof chrome;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

async function loadModule(): Promise<typeof import("../src/background/ttsPlayback")> {
  return import("../src/background/ttsPlayback");
}

function makeContext(): { contextType: string } {
  return { contextType: "OFFSCREEN_DOCUMENT" };
}

describe("offscreen 文档管理", () => {
  it("不存在时创建 offscreen 文档再转发播放", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, finished: true }));
    const createDocument = vi.fn(async (_opts: unknown) => undefined);
    installChrome({ sendMessage, createDocument });
    const { ttsPlay } = await loadModule();

    const res = await ttsPlay(makePlayReq());
    expect(res).toEqual({ finished: true });
    expect(createDocument).toHaveBeenCalledTimes(1);
    const arg = createDocument.mock.calls[0]?.[0] as { url: string; reasons: string[] };
    expect(arg.url).toBe("offscreen.html");
    expect(arg.reasons).toContain("AUDIO_PLAYBACK");
  });

  it("已存在 offscreen 文档时不重复创建", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, finished: true }));
    const createDocument = vi.fn(async () => undefined);
    installChrome({ sendMessage, createDocument, contexts: [makeContext()] });
    const { ttsPlay } = await loadModule();

    await ttsPlay(makePlayReq());
    expect(createDocument).not.toHaveBeenCalled();
  });

  it("getContexts API 不存在时视为不存在并创建（旧版本浏览器）", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, finished: true }));
    const createDocument = vi.fn(async () => undefined);
    installChrome({ sendMessage, createDocument, getContexts: false });
    const { ttsPlay } = await loadModule();

    await ttsPlay(makePlayReq());
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it("重复创建的「已存在」报错吞掉，不影响播放", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, finished: true }));
    const createDocument = vi.fn(async () => {
      throw new Error("Only a single offscreen document may be created");
    });
    installChrome({ sendMessage, createDocument });
    const { ttsPlay } = await loadModule();

    await expect(ttsPlay(makePlayReq())).resolves.toEqual({ finished: true });
  });

  it("非重复创建类错误上抛", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const createDocument = vi.fn(async () => {
      throw new Error("quota exceeded");
    });
    installChrome({ sendMessage, createDocument });
    const { ttsPlay } = await loadModule();

    await expect(ttsPlay(makePlayReq())).rejects.toThrow(/quota/);
  });
});

describe("ttsPlay 消息转发", () => {
  it("消息形状包含 type/requestId/audioBase64/contentType", async () => {
    const sendMessage = vi.fn(async (_msg: unknown) => ({ ok: true, finished: true }));
    installChrome({ sendMessage, contexts: [makeContext()] });
    const { ttsPlay } = await loadModule();

    await ttsPlay(makePlayReq());
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toEqual({
      type: "it-tts-play",
      requestId: "req-1",
      audioBase64: "AAAA",
      contentType: "audio/mp3",
    });
  });

  it("播放失败（ok=false）抛出错误并带上 error 文案", async () => {
    const sendMessage = vi.fn(async () => ({ ok: false, error: "解码失败" }));
    installChrome({ sendMessage, contexts: [makeContext()] });
    const { ttsPlay } = await loadModule();

    await expect(ttsPlay(makePlayReq())).rejects.toThrow(/解码失败/);
  });

  it("响应 undefined 也按失败抛出", async () => {
    const sendMessage = vi.fn(async () => undefined);
    installChrome({ sendMessage, contexts: [makeContext()] });
    const { ttsPlay } = await loadModule();

    await expect(ttsPlay(makePlayReq())).rejects.toThrow(/音频播放失败/);
  });

  it("offscreen 被回收：检测到不存在后重建并重试一次成功", async () => {
    // contexts 数组动态模拟文档生命周期；首次播放时模拟浏览器回收（清空），重试播放成功
    const contexts: unknown[] = [];
    let playCalls = 0;
    const sendMessage = vi.fn(async () => {
      playCalls++;
      if (playCalls === 1) {
        contexts.length = 0; // 播放期间被浏览器回收
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      return { ok: true, finished: true };
    });
    const createDocument = vi.fn(async () => {
      contexts.push({ contextType: "OFFSCREEN_DOCUMENT" });
    });
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        getContexts: vi.fn(async () => [...contexts]),
        ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
        sendMessage,
        getURL: (path: string) => `chrome-extension://test/${path}`,
      },
      offscreen: {
        createDocument,
        Reason: { AUDIO_PLAYBACK: "AUDIO_PLAYBACK" },
      },
    } as unknown as typeof chrome;
    const { ttsPlay } = await loadModule();

    // 首次播放：ensure 创建文档 → sendMessage 抛接收端错误（回收） →
    // 重试路径 ensure 检测到不存在再重建 → sendMessage 成功
    await expect(ttsPlay(makePlayReq())).resolves.toEqual({ finished: true });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(createDocument).toHaveBeenCalledTimes(2);
  });

  it("重试后仍失败则上抛", async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error("Receiving end does not exist");
    });
    installChrome({ sendMessage, contexts: [makeContext()] });
    const { ttsPlay } = await loadModule();

    // 重试仍收到接收端错误 → 上抛原始错误
    await expect(ttsPlay(makePlayReq())).rejects.toThrow(/Receiving end does not exist/);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("非接收端类错误直接上抛，不重试", async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error("network down");
    });
    installChrome({ sendMessage, contexts: [makeContext()] });
    const { ttsPlay } = await loadModule();

    await expect(ttsPlay(makePlayReq())).rejects.toThrow(/network down/);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("并发播放请求共享同一次 offscreen 创建", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, finished: true }));
    const createDocument = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    installChrome({ sendMessage, createDocument });
    const { ttsPlay } = await loadModule();

    await Promise.all([ttsPlay(makePlayReq()), ttsPlay(makePlayReq()), ttsPlay(makePlayReq())]);
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });
});

describe("keepAlive 引用计数配对", () => {
  async function loadWithSpies(): Promise<{
    ttsPlay: typeof import("../src/background/ttsPlayback").ttsPlay;
    begin: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  }> {
    beginKeepAliveSpy.mockClear();
    endKeepAliveSpy.mockClear();
    const { ttsPlay } = await loadModule();
    return { ttsPlay, begin: beginKeepAliveSpy, end: endKeepAliveSpy };
  }

  it("播放成功路径 begin/end 各一次", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true, finished: true }));
    installChrome({ sendMessage, contexts: [makeContext()] });
    const { ttsPlay, begin, end } = await loadWithSpies();
    await ttsPlay(makePlayReq());
    expect(begin).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("播放抛非接收端错误：finally 兜底 endKeepAlive，计数不泄漏", async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error("network down");
    });
    installChrome({ sendMessage, contexts: [makeContext()] });
    const { ttsPlay, begin, end } = await loadWithSpies();
    await expect(ttsPlay(makePlayReq())).rejects.toThrow(/network down/);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("两次尝试均失败（接收端持续不存在）后计数仍闭合", async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error("Receiving end does not exist");
    });
    installChrome({ sendMessage, contexts: [makeContext()] });
    const { ttsPlay, begin, end } = await loadWithSpies();
    await expect(ttsPlay(makePlayReq())).rejects.toThrow(/Receiving end/);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1); // 抛错前 endKeepAlive 已由 finally 执行
  });
});

describe("ttsStop", () => {
  it("转发停止消息", async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));
    installChrome({ sendMessage });
    const { ttsStop } = await loadModule();

    await ttsStop();
    expect(sendMessage).toHaveBeenCalledWith({ type: "it-tts-stop" });
  });

  it("接收端不存在时静默 no-op", async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error("Could not establish connection");
    });
    installChrome({ sendMessage });
    const { ttsStop } = await loadModule();

    await expect(ttsStop()).resolves.toBeUndefined();
  });

  it("其他错误上抛", async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error("boom");
    });
    installChrome({ sendMessage });
    const { ttsStop } = await loadModule();

    await expect(ttsStop()).rejects.toThrow(/boom/);
  });
});
