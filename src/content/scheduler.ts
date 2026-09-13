/** content 层主线程调度助手（借鉴 read-frog 的 scheduler 思路，防大页面卡顿）。
 *
 * MV3 content 脚本与页面共享主线程：一次性做大量同步 DOM 工作会冻结页面。
 * 因此把大块工作切成时间片，每片预算花完就让出主线程，让输入与渲染先跑。 */

/** 一个同步时间片的预算（毫秒）。read-frog 用 12ms，这里取同样量级。 */
export const WORK_BUDGET_MS = 12;

interface SchedulerLike {
  yield?: () => Promise<void>;
  postTask?: (callback: () => void, options?: { priority?: string }) => Promise<void>;
}

/**
 * 让出主线程，让输入/渲染先跑。优先级：
 * scheduler.yield（Chrome 129+）→ scheduler.postTask → MessageChannel（避开 setTimeout 的 4ms 钳制）→ setTimeout(0)。
 */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: SchedulerLike }).scheduler;
  if (typeof scheduler?.yield === "function") {
    return scheduler.yield();
  }
  if (typeof scheduler?.postTask === "function") {
    return scheduler.postTask(() => {}, { priority: "user-visible" });
  }
  if (typeof MessageChannel !== "undefined") {
    return new Promise((resolve) => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = () => {
        port1.close();
        resolve();
      };
      port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 工作量配速器：记录当前时间片的截止时间，供多个异步步骤共享同一个预算。 */
export interface WorkPacer {
  deadline: number;
  budgetMs: number;
}

export function createWorkPacer(budgetMs: number = WORK_BUDGET_MS): WorkPacer {
  return { deadline: performance.now() + budgetMs, budgetMs };
}

/** 当前时间片预算花完时让出主线程；否则立即返回（几乎零开销）。 */
export async function pauseIfBudgetSpent(pacer: WorkPacer): Promise<void> {
  if (performance.now() < pacer.deadline) return;
  await yieldToMain();
  pacer.deadline = performance.now() + pacer.budgetMs;
}
