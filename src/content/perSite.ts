/** 按站点/页面保留翻译设置：
 *  - 站点级（host）：目标语言 + 显示模式，再次进入该站时还原；
 *  - 页面级（host+pathname）：是否禁用自动翻译（用户在该子页点过「还原」），只影响该子页。
 */
import type { DisplayMode } from "../shared/types";

const PREFIX = "it-site:";
/** 存储键：被用户「还原」过、禁用自动翻译的页面键列表（host+pathname） */
const DISABLED_KEY = "it-disabled-pages";

export interface PerSiteSettings {
  targetLang: string;
  displayMode: DisplayMode;
}

function siteKey(host: string): string {
  return PREFIX + host;
}

/** 读取当前站点的翻译设置 */
export async function getPerSite(host: string): Promise<PerSiteSettings | undefined> {
  const key = siteKey(host);
  const res = await chrome.storage.local.get(key);
  return res[key] as PerSiteSettings | undefined;
}

/** 保存当前站点的翻译设置 */
export async function savePerSite(host: string, s: PerSiteSettings): Promise<void> {
  await chrome.storage.local.set({ [siteKey(host)]: s });
}

/** 当前页面 host（去掉 www） */
export function currentHost(): string {
  return location.hostname.replace(/^www\./, "").toLowerCase();
}

/** 当前页面键：host + pathname（区分同一站点下的不同子网页） */
export function currentPageKey(): string {
  return currentHost() + location.pathname;
}

// ===== 禁用自动翻译的页面集合（用户在该子页点过「还原」）=====
// 模块级内存缓存：主流程与工具条共享同一 Set，SPA 内切换时实时判断、无需重复读存储
let disabledCache: Set<string> | null = null;

/** 读取被禁用自动翻译的页面键集合（内存缓存，SPA 内共享） */
export async function getDisabledPages(): Promise<Set<string>> {
  if (disabledCache) return disabledCache;
  const res = await chrome.storage.local.get(DISABLED_KEY);
  const arr = res[DISABLED_KEY] as string[] | undefined;
  disabledCache = new Set(Array.isArray(arr) ? arr : []);
  return disabledCache;
}

/** it-disabled-pages 键的写互斥队列：快捷键触发「还原/翻译」会广播到同页所有 frame，
 *  顶 frame 与 iframe 并发执行「读集合 → 改 → 整体写回」时后写者会基于陈旧快照覆盖
 *  先写者的条目。写操作链到队尾串行执行，保证每个 frame 的增删都不丢。 */
let disabledQueue: Promise<unknown> = Promise.resolve();

/** 把某子页加入/移出「禁用自动翻译」集合（持久化 + 更新内存缓存）。
 *  持久化走互斥队列：以存储最新值为底（而非可能陈旧的内存缓存）读-改-写，
 *  mutator 收到深拷贝数组，多个 frame 的写严格串行、互不覆盖。 */
export function setPageDisabled(pageKey: string, disabled: boolean): Promise<void> {
  const run = async (): Promise<void> => {
    const res = await chrome.storage.local.get(DISABLED_KEY);
    const arr = res[DISABLED_KEY] as string[] | undefined;
    const list: string[] = Array.isArray(arr) ? structuredClone(arr) : [];
    if (disabled) {
      if (!list.includes(pageKey)) list.push(pageKey);
    } else {
      const idx = list.indexOf(pageKey);
      if (idx >= 0) list.splice(idx, 1);
    }
    await chrome.storage.local.set({ [DISABLED_KEY]: list });
    // 落盘成功后同步内存缓存（缓存保持引用稳定，供同步判断方实时读取）
    disabledCache = new Set(list);
  };
  const queued = disabledQueue.then(run, run);
  // 某次写失败不能让后续排队操作饿死；错误仍原样抛给当次调用方
  disabledQueue = queued.then(
    () => undefined,
    () => undefined
  );
  return queued;
}

/** 供测试重置内存缓存 */
export function __resetDisabledCache(): void {
  disabledCache = null;
}
