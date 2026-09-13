/**
 * 划词朗读控制器（content 侧状态机）回归测试：
 * - 正常链路：idle → fetching → playing → idle，消息顺序 tts-synthesize → tts-play；
 * - 播放中点击 = 停止：发 tts-stop、状态复位，晚到的播放响应不覆盖状态；
 * - 合成期间被停止：晚到的合成结果被丢弃（不发 tts-play）；
 * - 合成中重复点击忽略；合成/播放失败 → error 态并自动复位；
 * - 关闭气泡（stop）后一切在途请求作废。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtsController, type TtsState } from "../src/content/tts";

type SendFn = (msg: Record<string, unknown>) => Promise<unknown>;

function mockRuntime(send: SendFn): ReturnType<typeof vi.fn> {
  const fn = vi.fn(send);
  (globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage: fn } };
  return fn;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

/** 依次回放事件序列的辅助：states 记录 onChange 的全部状态 */
function makeController() {
  const states: TtsState[] = [];
  const ctl = new TtsController((s) => states.push(s));
  return { ctl, states };
}

describe("TtsController 状态机", () => {
  it("正常链路：合成 → 播放 → 空闲，消息顺序与载荷正确", async () => {
    const send = mockRuntime(async (msg) => {
      if (msg.type === "tts-synthesize") {
        return { id: msg.id, ok: true, audioBase64: "QUJD", contentType: "audio/mpeg" };
      }
      return { id: msg.id, ok: true, finished: true };
    });
    const { ctl, states } = makeController();
    const p = ctl.toggle("你好", "zh-CN");
    expect(ctl.getState()).toBe("fetching");
    await p;
    expect(states).toEqual(["fetching", "playing", "idle"]);
    expect(ctl.getState()).toBe("idle");
    const types = send.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toEqual(["tts-synthesize", "tts-play"]);
    const playMsg = send.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(playMsg.audioBase64).toBe("QUJD");
    expect(typeof playMsg.requestId).toBe("string");
  });

  it("播放中点击 = 停止：发 tts-stop 复位，晚到的播放响应不覆盖状态", async () => {
    let resolvePlay: (v: unknown) => void = () => undefined;
    const send = mockRuntime(async (msg) => {
      if (msg.type === "tts-synthesize") {
        return { ok: true, audioBase64: "QUJD", contentType: "audio/mpeg" };
      }
      if (msg.type === "tts-play") {
        return new Promise((resolve) => {
          resolvePlay = resolve;
        });
      }
      return { ok: true };
    });
    const { ctl, states } = makeController();
    const p = ctl.toggle("你好", "zh-CN");
    await vi.waitFor(() => expect(ctl.getState()).toBe("playing"), { timeout: 1000 });
    ctl.stop(); // 用户点「停止」
    expect(ctl.getState()).toBe("idle");
    resolvePlay({ ok: true, finished: false });
    await p;
    // 晚到的响应不覆盖：状态保持 idle，且补发了 tts-stop
    expect(ctl.getState()).toBe("idle");
    expect(states.filter((s) => s === "playing").length).toBe(1);
    expect(send.mock.calls.some((c) => (c[0] as { type: string }).type === "tts-stop")).toBe(true);
  });

  it("合成期间停止：晚到的合成结果被丢弃，不发 tts-play", async () => {
    const send = mockRuntime(
      () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, audioBase64: "QUJD" }), 100))
    );
    const { ctl } = makeController();
    const p = ctl.toggle("你好", "zh-CN");
    expect(ctl.getState()).toBe("fetching");
    ctl.stop(); // 气泡关闭 / 再次点击前的放弃
    await vi.advanceTimersByTimeAsync(200); // 让晚到的合成结果返回（应被丢弃）
    await p;
    expect(ctl.getState()).toBe("idle");
    expect(send.mock.calls.some((c) => (c[0] as { type: string }).type === "tts-play")).toBe(false);
  });

  it("合成中重复点击被忽略", async () => {
    mockRuntime(async () => ({ ok: true, audioBase64: "QUJD" }));
    const { ctl } = makeController();
    const p1 = ctl.toggle("你好", "zh-CN");
    await ctl.toggle("世界", "zh-CN"); // fetching 中：直接忽略
    await p1;
    // 只有一次合成（第二次 toggle 被忽略）
    const count = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } })
      .chrome.runtime.sendMessage.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === "tts-synthesize"
      ).length;
    expect(count).toBe(1);
  });

  it("合成失败 → error 态（带错误信息）→ 3 秒后自动复位", async () => {
    mockRuntime(async () => ({ ok: false, error: "Edge TTS 合成失败（HTTP 500）" }));
    const { ctl, states } = makeController();
    await ctl.toggle("你好", "zh-CN");
    expect(ctl.getState()).toBe("error");
    await vi.advanceTimersByTimeAsync(3100);
    expect(ctl.getState()).toBe("idle");
    expect(states.at(-2)).toBe("error");
  });

  it("播放失败 → error 态", async () => {
    mockRuntime(async (msg) =>
      msg.type === "tts-synthesize"
        ? { ok: true, audioBase64: "QUJD" }
        : { ok: false, error: "音频解码/播放失败" }
    );
    const { ctl } = makeController();
    await ctl.toggle("你好", "zh-CN");
    expect(ctl.getState()).toBe("error");
  });

  it("stop() 在空闲态是 no-op（不发 tts-stop）", async () => {
    const send = mockRuntime(async () => ({ ok: true }));
    const { ctl } = makeController();
    ctl.stop();
    expect(send).not.toHaveBeenCalled();
  });
});
