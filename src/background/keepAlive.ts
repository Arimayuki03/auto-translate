/**
 * MV3 service worker 保活：长时间在途的翻译请求（超时上限 120s，流式首 delta 前的
 * 静默生成期更长）既不是扩展 API 调用也没有 Port 消息，worker 空闲 30s 可能被浏览器
 * 回收——sendResponse 通道 / Port 随之中断，整批结果丢失。
 * 在途请求存在期间周期性调用一次 no-op 扩展 API（getPlatformInfo）重置空闲计时器，
 * 全部请求结束后停止，不留悬挂定时器。
 */
const INTERVAL_MS = 20_000;

let active = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function poke(): void {
  try {
    // no-op 探针只为重置空闲计时器，rejection 一并吞掉（unhandled rejection 会污染 SW 日志）
    void chrome.runtime.getPlatformInfo().catch(() => undefined);
  } catch {
    // 无 runtime 的环境（单测）：保活只在真实扩展环境有意义，跳过即可
  }
}

/** 标记一个在途翻译开始（引用计数；首个请求启动周期保活） */
export function beginKeepAlive(): void {
  active++;
  if (timer) return;
  if (typeof chrome === "undefined" || !chrome.runtime?.getPlatformInfo) return;
  poke();
  timer = setInterval(poke, INTERVAL_MS);
}

/** 标记一个在途翻译结束（最后一个结束后停止保活） */
export function endKeepAlive(): void {
  active = Math.max(0, active - 1);
  if (active === 0 && timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
