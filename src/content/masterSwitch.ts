/** 插件总开关（settings.enabled）在 content 侧的实时同步。
 *  popup / 设置页保存都写 chrome.storage.local，onChanged 自动广播到所有扩展上下文
 *  （含每个 frame 的 content script）——无需 background 中继、无需刷新页面。
 *  这里只放纯同步逻辑（事件 → 运行态翻转 + 开/关副作用回调），装配依赖由 index.ts 注入。 */
import type { Settings } from "../shared/types";

/** 从 onChanged 条目 / storage.get 快照里读总开关值；
 *  整段缺失或老版本数据无 enabled 字段 → 视为开启（与 DEFAULT_SETTINGS 一致） */
function enabledOf(s: unknown): boolean {
  return (s as Settings | undefined)?.enabled ?? true;
}

/** 开关关闭时注入的 frame 挂的轻量监听：等 popup 重新开启后补做完整装配（main 重跑），
 *  消费到「开启」即注销自我；若注销瞬间开关又已被关回，重跑的 main() 会按最新设置重新决定。 */
export function watchMasterSwitchReopen(reopen: () => void): void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string
  ): void => {
    if (areaName !== "local" || !changes.settings) return;
    if (!enabledOf(changes.settings.newValue)) return;
    chrome.storage.onChanged.removeListener(listener);
    reopen();
  };
  chrome.storage.onChanged.addListener(listener);
}

/** 已装配 frame 的开关运行态同步钩子 */
export interface MasterSwitchHooks {
  /** 读当前运行态镜像 */
  getEnabled(): boolean;
  /** 写运行态镜像（isBlocked 等判定的唯一依据） */
  setEnabled(v: boolean): void;
  /** 开关变关：还原已译内容、收起工具条 */
  onOff(): void;
  /** 开关变开：恢复工具条、按自动翻译设置补译当前页 */
  onOn(): void;
}

/** 装配完成后挂上的总开关监听：
 *  1) onChanged 只响应 enabled 的翻转（其它设置项的保存不打扰运行态）；
 *  2) 挂上监听后再做一次快照对读——watch 监听注销自我与本监听挂上之间存在装配窗口
 *     （多次 await），期间落盘的开关写入不会重放；不回填的话该 frame 会在
 *     「全局已关闭」的状态下继续自动翻译。 */
export function installMasterSwitchSync(hooks: MasterSwitchHooks): void {
  const apply = (next: boolean): void => {
    if (next === hooks.getEnabled()) return;
    hooks.setEnabled(next);
    if (next) hooks.onOn();
    else hooks.onOff();
  };
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.settings) return;
    const next = enabledOf(changes.settings.newValue);
    const prev = enabledOf(changes.settings.oldValue);
    if (next === prev) return; // 只响应总开关变化
    apply(next);
  });
  void chrome.storage.local.get("settings").then((cur) => apply(enabledOf(cur.settings)));
}
