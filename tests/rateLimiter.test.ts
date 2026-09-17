/**
 * 令牌桶限速器（TokenBucket）单元测试：
 * - 桶满时突发请求全部立即放行；
 * - 桶空后按速率返回等待毫秒数，时间推进后可再取；
 * - configure 调整容量：调小只钳制不补满，调大不凭空补满超出已累积的量；
 * - 容量下限钳制为 1。
 * 时间相关行为通过 vi.useFakeTimers 推进 Date.now，不真实等待。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenBucket } from "../src/background/rateLimiter";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TokenBucket 基础取令牌", () => {
  it("桶满时允许容量个请求立即通过（burst）", () => {
    const bucket = new TokenBucket(2, 3);
    expect(bucket.tryAcquire()).toBe(0);
    expect(bucket.tryAcquire()).toBe(0);
    expect(bucket.tryAcquire()).toBe(0);
    // 第 4 个请求需等待
    expect(bucket.tryAcquire()).toBeGreaterThan(0);
  });

  it("桶空后返回按速率计算的等待毫秒数", () => {
    // rate=2/s：取 1 个令牌需 500ms
    const bucket = new TokenBucket(2, 2);
    bucket.tryAcquire();
    bucket.tryAcquire();
    expect(bucket.tryAcquire()).toBe(500);
  });

  it("时间推进补充令牌后可再次取到", () => {
    const bucket = new TokenBucket(2, 1);
    expect(bucket.tryAcquire()).toBe(0);
    expect(bucket.tryAcquire()).toBe(500);
    vi.advanceTimersByTime(500);
    expect(bucket.tryAcquire()).toBe(0);
    // 再取又要等一个令牌周期
    expect(bucket.tryAcquire()).toBe(500);
  });

  it("长时间空闲后桶重新补满，不累积超容量", () => {
    const bucket = new TokenBucket(10, 2);
    bucket.tryAcquire();
    bucket.tryAcquire();
    // 空闲 1 分钟：最多补回 2 个（容量上限），不会囤积
    vi.advanceTimersByTime(60_000);
    expect(bucket.tryAcquire()).toBe(0);
    expect(bucket.tryAcquire()).toBe(0);
    expect(bucket.tryAcquire()).toBeGreaterThan(0);
  });
});

describe("TokenBucket.configure 调整速率与容量", () => {
  it("容量调小只钳制现有令牌数，不补满", () => {
    const bucket = new TokenBucket(5, 10);
    bucket.tryAcquire();
    bucket.tryAcquire();
    bucket.tryAcquire();
    // 剩 7 个，收窄到 4 → 保留 4 而不是补满到 10
    bucket.configure(5, 4);
    vi.advanceTimersByTime(10_000);
    let acquired = 0;
    while (bucket.tryAcquire() === 0) acquired++;
    expect(acquired).toBe(4);
  });

  it("调整速率影响等待时间计算", () => {
    const bucket = new TokenBucket(1, 1);
    bucket.tryAcquire();
    expect(bucket.tryAcquire()).toBe(1000);
    bucket.configure(4, 1);
    expect(bucket.tryAcquire()).toBe(250);
  });
});

describe("TokenBucket 边界参数", () => {
  it("容量钳制为至少 1", () => {
    const bucket = new TokenBucket(2, 0);
    expect(bucket.tryAcquire()).toBe(0);
    expect(bucket.tryAcquire()).toBe(500);
    bucket.configure(2, -5);
    // 收窄后现有令牌被钳到 0，冻结时间下需等一个令牌周期
    expect(bucket.tryAcquire()).toBe(500);
    vi.advanceTimersByTime(500);
    expect(bucket.tryAcquire()).toBe(0);
  });
});
