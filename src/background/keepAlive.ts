/**
 * MV3 service worker 保活：长时间在途的翻译请求（超时上限 120s，流式首 delta 前的
 * 静默生成期更长）既不是扩展 API 调用也没有 Port 消息，worker 空闲 30s 可能被浏览器
 * 回收——sendResponse 通道 / Port 随之中断，整批结果丢失。
 * 在途请求存在期间周期性调用一次 no-op 扩展 API（getPlatformInfo）重置空闲计时器，
 * 全部请求结束后停止，不留悬挂定时器。
 *
 * 硬上限：保活 interval 由 begin/end 引用计数驱动，若某个在途请求因缺陷永不结束
 * （如历史缺陷：响应体读取在超时作用域之外，promise 永不 settle → endKeepAlive
 * 永不执行），alarm 会永久存活、持续唤醒 worker。为兜底这类缺陷，从第一次
 * beginKeepAlive 起算超过 MAX_LIFETIME_MS 后自动停止心跳并重置计数。
 */
const INTERVAL_MS = 20_000;
/** 保活硬上限：从首次 begin 起算 30 分钟。正常翻译远用不满（超时上限 120s +
 *  重试/备用切换），超限意味着有请求悬挂，继续保活只会空耗电量并阻止 SW 回收。 */
const MAX_LIFETIME_MS = 30 * 60_000;

let active = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;

function poke(): void {
  try {
    // no-op 探针只为重置空闲计时器，rejection 一并吞掉（unhandled rejection 会污染 SW 日志）
    void chrome.runtime.getPlatformInfo().catch(() => undefined);
  } catch {
    // 无 runtime 的环境（单测）：保活只在真实扩展环境有意义，跳过即可
  }
}

/** 停止周期心跳与硬上限计时器（硬上限超限时 warn 一次） */
function stop(reason?: "expired"): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  if (lifetimeTimer) {
    clearTimeout(lifetimeTimer);
    lifetimeTimer = undefined;
  }
  if (reason === "expired") {
    // 只 warn 一次（stop(expired) 只会被硬上限触发一次，下次 begin 重新起算）
    console.warn(
      "[auto-translate] 保活超过 30 分钟硬上限，自动停止。可能存在永不结束的在途请求（缺陷），请排查。"
    );
  }
}

/** 标记一个在途翻译开始（引用计数；首个请求启动周期保活 + 硬上限计时） */
export function beginKeepAlive(): void {
  active++;
  if (typeof chrome === "undefined" || !chrome.runtime?.getPlatformInfo) return;
  if (timer) return;
  poke();
  timer = setInterval(poke, INTERVAL_MS);
  // 硬上限从「本轮第一次 begin」起算：即便 endKeepAlive 因缺陷永不执行，
  // 到期后也强制停掉心跳，不让 alarm 永久存活
  lifetimeTimer = setTimeout(() => {
    // 硬上限触发：撤走心跳与自身、归零引用计数，warn 一次
    stop("expired");
    active = 0;
  }, MAX_LIFETIME_MS);
}

/** 标记一个在途翻译结束（最后一个结束后停止保活；提前结束则一并撤掉硬上限计时） */
export function endKeepAlive(): void {
  active = Math.max(0, active - 1);
  if (active === 0) stop();
}
