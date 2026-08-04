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

/** 把某子页加入/移出「禁用自动翻译」集合（持久化 + 更新内存缓存） */
export async function setPageDisabled(pageKey: string, disabled: boolean): Promise<void> {
  const set = await getDisabledPages();
  if (disabled) set.add(pageKey);
  else set.delete(pageKey);
  await chrome.storage.local.set({ [DISABLED_KEY]: [...set] });
}

/** 供测试重置内存缓存 */
export function __resetDisabledCache(): void {
  disabledCache = null;
}
