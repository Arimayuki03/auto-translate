/**
 * 令牌桶限速器（借鉴 read-frog 的 RequestQueue 思路）：
 * - rate：每秒补充的令牌数，决定长期平均请求速率上限；
 * - capacity：桶容量，允许短时间突发（burst）最多 capacity 个请求，
 *   之后按 rate 匀速补充——既防瞬时高并发封号，又不至于把并发全压成串行。
 */
export class TokenBucket {
  private rate: number;
  private capacity: number;
  private tokens: number;
  private lastRefill: number;

  constructor(rate: number, capacity: number) {
    this.rate = rate;
    this.capacity = Math.max(1, capacity);
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  /**
   * 尝试取一个令牌。拿到返回 0；拿不到返回还需等待的毫秒数（调用方 sleep 后重试）。
   * 内部用时间差结算令牌补充，不依赖定时器，空闲后首个请求也无需等待。
   */
  tryAcquire(): number {
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    if (elapsedMs > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + (elapsedMs / 1000) * this.rate);
      this.lastRefill = now;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    // 距离凑够 1 个令牌还差多少毫秒
    return Math.ceil(((1 - this.tokens) / this.rate) * 1000);
  }

  /** 调整速率/容量（设置变更时调用）。容量调小只钳制、不补满，避免突变白送突发额度。 */
  configure(rate: number, capacity: number): void {
    this.rate = rate;
    this.capacity = Math.max(1, capacity);
    this.tokens = Math.min(this.tokens, this.capacity);
  }
}
