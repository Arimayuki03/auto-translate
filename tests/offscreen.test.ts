/**
 * offscreen 音频播放器（public/offscreen.js）回归测试：
 * 1. it-tts-play → Audio 播放，自然结束回 { ok: true, finished: true }；
 * 2. 并发 play：第二条到达时打断第一条（旧请求回 { ok: true, finished: false }，
 *    新音频开播）——「最新请求优先」语义；
 * 3. it-tts-stop → 停止当前播放并回 { ok: true, finished: false }，stop 消息本身同步回 { ok: true }；
 * 4. audio.onerror → 回包 ok:false（解码/播放失败）；
 * 5. settle 幂等：结束 + stop 双重触发只回一次包。
 *
 * 环境说明：offscreen.js 顶层只执行 chrome.runtime.onMessage.addListener，Audio/
 * URL.createObjectURL 都在 play() 调用时才引用——因此先装 chrome stub 再 import，
 * 导入完成后才打播放期补丁。注意不能整体替换 globalThis.URL（会破坏 vite 模块
 * 加载器内部的 new URL()），只替换 URL 的静态方法；node ≥18 自带 Blob/atob，
 * 无需 stub。current 是模块文件级单例，每用例 vi.resetModules() 重新加载。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Response = { ok: boolean; finished?: boolean; error?: string };

/** 可控的 Audio 桩：记录 play/pause 调用，用例手工触发 onended/onerror */
function makeAudioCtor() {
  const instances: {
    src: string;
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
    onerror: (() => void) | null;
  }[] = [];
  const AudioCtor = vi.fn(function (this: unknown, src: string) {
    const inst = {
      src,
      play: vi.fn(() => Promise.resolve()),
      pause: vi.fn(),
      load: vi.fn(),
      // settle 的 try 块依次调 pause/removeAttribute/load/revoke：缺 removeAttribute
      // 会让 try 中途抛错（被 catch 吞掉），revokeObjectURL 被跳过
      removeAttribute: vi.fn(),
      onended: null,
      onerror: null,
    };
    instances.push(inst);
    return inst;
  });
  return { AudioCtor, instances };
}

type OffscreenDeps = ReturnType<typeof makeAudioCtor>;

type UrlStubs = {
  createObjectURL: ReturnType<typeof vi.fn>;
  revokeObjectURL: ReturnType<typeof vi.fn>;
  origCreate: typeof URL.createObjectURL;
  origRevoke: typeof URL.revokeObjectURL;
};

let urlStubs: UrlStubs | null = null;

/** stub chrome → 动态加载 offscreen.js → 再打 Audio/URL 静态方法补丁，捕获消息处理器 */
async function loadOffscreen(deps: OffscreenDeps) {
  const g = globalThis as Record<string, unknown>;
  const listeners: ((msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | undefined)[] = [];
  g.chrome = {
    runtime: {
      onMessage: {
        addListener: (fn: (typeof listeners)[number]) => listeners.push(fn),
      },
    },
  };
  vi.resetModules();
  // public/offscreen.js 是零依赖普通 JS（无类型声明），any 导入是预期
  // @ts-expect-error TS7016: no declaration file for plain-JS extension script
  await import("../public/offscreen.js"); // 顶层只注册监听器，安全
  // 播放期依赖补丁：Audio 挂 globalThis（node 无此全局）；URL 只换静态方法
  g.Audio = deps.AudioCtor;
  urlStubs = {
    createObjectURL: vi.fn(() => `blob:mock-${deps.instances.length}`),
    revokeObjectURL: vi.fn(),
    origCreate: URL.createObjectURL,
    origRevoke: URL.revokeObjectURL,
  };
  URL.createObjectURL = urlStubs.createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = urlStubs.revokeObjectURL as unknown as typeof URL.revokeObjectURL;
  return {
    /** 按协议发消息：sendResponse 捕获的回包经 promise 返回；lastReturn 记录监听器同步返回值 */
    send(msg: unknown): Promise<Response | undefined> {
      return new Promise((resolveResponse) => {
        for (const fn of listeners) {
          const ret = fn(msg, {}, (r: unknown) => resolveResponse(r as Response));
          mod.lastReturn = ret;
          if (ret === true || ret === false) return; // true=异步回包 false=同步已回包
        }
        // 无监听器认领（不应发生）：下一微任务回 undefined 给出清晰失败
        Promise.resolve().then(() => resolveResponse(undefined));
      });
    },
    /** 最近一次监听器调用的同步返回值（true=异步回包，false=同步回包） */
    lastReturn: undefined as boolean | undefined,
    listeners,
  };
}

function restoreGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  delete g.chrome;
  delete g.Audio;
  if (urlStubs) {
    URL.createObjectURL = urlStubs.origCreate;
    URL.revokeObjectURL = urlStubs.origRevoke;
    urlStubs = null;
  }
}

/** "QUJD" = "ABC" 的 Base64，合法可解码 */
const AUDIO_B64 = "QUJD";

let deps: OffscreenDeps;
let mod: Awaited<ReturnType<typeof loadOffscreen>>;

beforeEach(() => {
  deps = makeAudioCtor();
});
afterEach(() => {
  restoreGlobals();
  vi.restoreAllMocks();
});

describe("offscreen 音频播放器", () => {
  it("it-tts-play → Audio 播放，onended 回 { ok: true, finished: true }", async () => {
    mod = await loadOffscreen(deps);
    const p = mod.send({ type: "it-tts-play", requestId: "r1", audioBase64: AUDIO_B64, contentType: "audio/mpeg" });
    // 监听器返回 true：异步回包协议
    expect(mod.lastReturn).toBe(true);
    expect(deps.instances).toHaveLength(1);
    expect(deps.instances[0]!.src).toMatch(/^blob:mock/);
    expect(deps.instances[0]!.play).toHaveBeenCalledTimes(1);

    deps.instances[0]!.onended!();
    await expect(p).resolves.toEqual({ ok: true, finished: true });
    // 收尾：revoke 播放用的 blob URL
    expect(urlStubs!.revokeObjectURL).toHaveBeenCalledWith(deps.instances[0]!.src);
  });

  it("并发 play：第二条打断第一条（旧回 finished:false，新音频开播）", async () => {
    mod = await loadOffscreen(deps);
    const p1 = mod.send({ type: "it-tts-play", requestId: "r1", audioBase64: AUDIO_B64 });
    const audio1 = deps.instances[0]!;
    expect(audio1.play).toHaveBeenCalledTimes(1);

    const p2 = mod.send({ type: "it-tts-play", requestId: "r2", audioBase64: AUDIO_B64 });
    await expect(p1).resolves.toEqual({ ok: true, finished: false }); // 旧请求被停
    expect(deps.instances).toHaveLength(2); // 新音频已创建
    expect(deps.instances[1]!.play).toHaveBeenCalledTimes(1); // 已开播

    deps.instances[1]!.onended!();
    await expect(p2).resolves.toEqual({ ok: true, finished: true });
  });

  it("it-tts-stop → 当前播放回 { ok: true, finished: false }，stop 消息同步回 { ok: true }", async () => {
    mod = await loadOffscreen(deps);
    const p = mod.send({ type: "it-tts-play", requestId: "r1", audioBase64: AUDIO_B64 });
    const audio = deps.instances[0]!;

    const stopRet = mod.listeners[0]!({ type: "it-tts-stop" }, {}, () => undefined);
    expect(stopRet).toBe(false); // stop 同步回包
    await expect(p).resolves.toEqual({ ok: true, finished: false });
    expect(audio.pause).toHaveBeenCalled(); // 播放被停止
    expect(urlStubs!.revokeObjectURL).toHaveBeenCalledWith(audio.src);

    // 空闲时 stop 是 no-op：回 { ok: true }，不抛错
    const idleAck: unknown[] = [];
    mod.listeners[0]!({ type: "it-tts-stop" }, {}, (r) => idleAck.push(r));
    expect(idleAck).toEqual([{ ok: true }]);
  });

  it("audio.onerror → 回包 ok:false（解码/播放失败）", async () => {
    mod = await loadOffscreen(deps);
    const p = mod.send({ type: "it-tts-play", requestId: "r1", audioBase64: AUDIO_B64 });
    deps.instances[0]!.onerror!();
    await expect(p).resolves.toEqual({ ok: false, error: "音频解码/播放失败" });
  });

  it("settle 幂等：onended 与 stop 双重触发只回一次包", async () => {
    mod = await loadOffscreen(deps);
    const p = mod.send({ type: "it-tts-play", requestId: "r1", audioBase64: AUDIO_B64 });
    const audio = deps.instances[0]!;

    audio.onended!(); // 自然结束：回 finished:true
    await expect(p).resolves.toEqual({ ok: true, finished: true });
    const pauseCalls = audio.pause.mock.calls.length;

    mod.listeners[0]!({ type: "it-tts-stop" }, {}, () => undefined); // 迟到的 stop：不应二次回包/二次清理
    expect(audio.pause.mock.calls.length).toBe(pauseCalls); // settle 已置空 current，不再触碰 audio
  });
});
