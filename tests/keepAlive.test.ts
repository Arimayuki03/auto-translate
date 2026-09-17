/**
 * MV3 service worker 保活（keepAlive）单元测试：
 * - 首个在途请求立即 poke 一次并启动周期心跳，结束后停止；
 * - 引用计数：多个并发请求期间保持心跳，全部结束才停止；
 * - endKeepAlive 多余调用安全（计数不为负、不误触发）；
 * - 每次 beginKeepAlive 都立即 poke 一次（重置空闲计时器）；
 * - 无 chrome.runtime 环境（单测）下 beginKeepAlive 静默跳过、不抛错。
 * 停止与否通过「推进时间后不再 poke」行为断言，不依赖具体 timer 实现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getPlatformInfo = vi.fn(async () => ({ os: "win" }));

beforeEach(() => {
  vi.resetModules();
  getPlatformInfo.mockClear();
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { getPlatformInfo },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  (globalThis as { chrome?: unknown }).chrome = undefined;
});

async function loadModule(): Promise<typeof import("../src/background/keepAlive")> {
  return import("../src/background/keepAlive");
}

describe("keepAlive 引用计数保活", () => {
  it("首个请求立即 poke 一次并启动心跳，结束后停止", async () => {
    vi.useFakeTimers();
    const { beginKeepAlive, endKeepAlive } = await loadModule();
    beginKeepAlive();
    expect(getPlatformInfo).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(40_000);
    expect(getPlatformInfo.mock.calls.length).toBeGreaterThanOrEqual(2);

    endKeepAlive();
    const pokesAtEnd = getPlatformInfo.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    // 结束后不再 poke
    expect(getPlatformInfo.mock.calls.length).toBe(pokesAtEnd);
    vi.useRealTimers();
  });

  it("并发多个请求：全部结束才停止保活", async () => {
    vi.useFakeTimers();
    const { beginKeepAlive, endKeepAlive } = await loadModule();
    beginKeepAlive();
    beginKeepAlive();
    beginKeepAlive();

    endKeepAlive();
    endKeepAlive();
    const pokesMid = getPlatformInfo.mock.calls.length;
    vi.advanceTimersByTime(40_000);
    // 仍有 1 个在途：心跳继续
    expect(getPlatformInfo.mock.calls.length).toBeGreaterThan(pokesMid);

    endKeepAlive();
    const pokesEnd = getPlatformInfo.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(getPlatformInfo.mock.calls.length).toBe(pokesEnd);
    vi.useRealTimers();
  });

  it("endKeepAlive 多余调用安全：计数不为负、不误触发 poke", async () => {
    vi.useFakeTimers();
    const { beginKeepAlive, endKeepAlive } = await loadModule();
    endKeepAlive(); // 无在途时的多余调用
    beginKeepAlive();
    endKeepAlive();
    endKeepAlive(); // 重复调用
    const pokesAtEnd = getPlatformInfo.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(getPlatformInfo.mock.calls.length).toBe(pokesAtEnd);
    vi.useRealTimers();
  });

  it("再次 begin 会重新启动心跳：每次 begin 都立即 poke", async () => {
    vi.useFakeTimers();
    const { beginKeepAlive, endKeepAlive } = await loadModule();
    beginKeepAlive();
    endKeepAlive();

    beginKeepAlive();
    // 第二次 begin 立即 poke（重置空闲计时器），累计 2 次
    expect(getPlatformInfo).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(20_000);
    expect(getPlatformInfo).toHaveBeenCalledTimes(3);
    endKeepAlive();
    vi.useRealTimers();
  });
});

describe("keepAlive 无扩展环境", () => {
  it("无 chrome 时静默跳过，不抛错不 poke", async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    const { beginKeepAlive, endKeepAlive } = await loadModule();
    expect(() => {
      beginKeepAlive();
      endKeepAlive();
    }).not.toThrow();
    expect(getPlatformInfo).not.toHaveBeenCalled();
  });

  it("chrome.runtime.getPlatformInfo 缺失时同样静默跳过", async () => {
    (globalThis as { chrome?: unknown }).chrome = { runtime: {} };
    const { beginKeepAlive, endKeepAlive } = await loadModule();
    expect(() => {
      beginKeepAlive();
      endKeepAlive();
    }).not.toThrow();
    expect(getPlatformInfo).not.toHaveBeenCalled();
  });

  it("poke 对 getPlatformInfo 的返回消费 rejection（.catch 在场）", async () => {
    // 不依赖进程 "unhandledRejection" 事件做断言：vitest 的模块运行器下收不到该事件
    // （探针验证：微任务/宏任务之后计数恒为 0），旧写法实测为空转——删掉源码的
    // .catch() 也全绿。改为直接断言行为契约：poke 必须对返回的 promise 挂上
    // rejection handler；stub 的 catch 没被调用 = 源码丢了 .catch() = 本用例红。
    const catchSpy = vi.fn();
    getPlatformInfo.mockImplementationOnce(() => ({ catch: catchSpy }) as never);
    const { beginKeepAlive, endKeepAlive } = await loadModule();
    beginKeepAlive();
    expect(catchSpy).toHaveBeenCalledTimes(1);
    expect(catchSpy.mock.calls[0]?.[0]).toBeTypeOf("function"); // 挂的是 rejection 处理函数
    endKeepAlive();
  });
});
