/**
 * SPA 路由导航检测与重译编排（独立模块，便于单测）。
 * GitHub/Turbo 等 SPA 换页不重载页面，content script 不会重跑。这里统一拦截所有换页信号
 * —— pushState/replaceState 补丁、popstate、<body> 整体替换（observer 上报）、bfcache 恢复、
 * URL 轮询兜底 —— 换页后重置旧页状态、重建工具条并按需延迟重译。
 *
 * 关键点：同一导航可能被多个信号重复触发（点击换页 = pushState 先行，随后 <body> 被整体替换，
 * observer 又上报一次）。第二次触发不能再次 reset（会把刚译好的内容清掉、闪回原文），
 * 只应保证延迟重译兜底。用「同一 URL 在去重窗口内已处理」来区分重复触发与真正的换页。
 */
import type { PageEngine } from "./engine";
import type { PageObserver } from "./observer";
import type { Renderer } from "./renderer";

/** SPA 换页后延迟多久重译（等框架把新内容换进 DOM；Turbo/PJAX 本地换页通常在百毫秒内） */
const SWAP_DELAY_MS = 200;
/** URL 轮询兜底间隔：防框架绕过 pushState 补丁，任何 URL 变化都不漏 */
const URL_POLL_MS = 1000;
/** 同一 URL 在这段时间内的第二次换页信号视为重复触发（pushState 与 body 替换会前后脚触发） */
const DEDUP_MS = 1000;

/** 去掉 hash 后的 URL：用于识别「仅锚点/hash 变化」的同页跳转 */
function stripHash(url: string): string {
  return url.replace(/#.*$/, "");
}

export interface SpaNavigationOptions {
  engine: PageEngine;
  renderer: Renderer;
  observer: PageObserver;
  /** 确保工具条在 DOM 中：body 被整体替换时旧工具条已消失，需重建 */
  ensureToolbar: () => void;
  /** 是否开启自动翻译 */
  autoTranslate: boolean;
  /** 当前 URL 是否敏感页（登录/密码/2FA 等），敏感时不翻译 */
  isSensitive: () => boolean;
  /** 当前子页是否被用户「还原」过（禁用自动翻译），只影响该子页 */
  isPageDisabled: () => boolean;
  /** 真正换页（URL 变化，hash 微调不算）时的额外动作：换页后按新 URL 重解析站点规则等。
   *  在 resetForNavigation 之后、延迟重译之前调用。 */
  onNavigation?: () => void;
}

export function setupSpaNavigation(opts: SpaNavigationOptions): void {
  let lastNavUrl = location.href;
  let lastNavAt = 0;
  let navTimer: number | undefined;

  const handleNavigate = (reason: string, force = false): void => {
    const sameUrl = location.href === lastNavUrl;
    // 非强制（pushState/replaceState/popstate/轮询）：同 URL 的微调不算换页
    if (!force && sameUrl) return;
    // 仅 hash 变化（已译页点击 #toc 锚点、hash 路由的浅层跳转）：页面主体未换，
    // 清空整页译文只会闪回原文并浪费 token。hash 路由真正换内容时 <body> 或子树会被
    // 整体替换，observer 的 force 信号 / mutation 增量路径会兜底重置与补译。
    if (!force && stripHash(location.href) === stripHash(lastNavUrl)) {
      lastNavUrl = location.href; // 吸收 hash 变化，URL 轮询不再反复进入本函数
      return;
    }
    // 强制（observer 上报 body 替换）：同一 URL 短期内已被处理过 → 同一导航的重复信号，
    // 不重复 reset（避免清掉刚译好的内容闪回原文），但仍兜底重译一次
    const duplicate = force && sameUrl && Date.now() - lastNavAt < DEDUP_MS;
    if (!duplicate) {
      console.debug(`[auto-translate] SPA 导航: ${reason}`);
      lastNavUrl = location.href;
      lastNavAt = Date.now();
      opts.engine.resetForNavigation();
      opts.onNavigation?.(); // 换页后按新 URL 重建站点规则等（先于延迟重译，新页首扫即用新规则）
    }
    // 该子页被用户「还原」过（禁用自动翻译）：保持原文、引擎回到未翻译态、不重译。
    // 在重建工具条之前处理，让工具条按「未翻译」态初始化。
    if (opts.isPageDisabled()) {
      opts.engine.restore();
      opts.ensureToolbar();
      clearTimeout(navTimer);
      return;
    }
    // body 可能已被整体替换（即使 duplicate）：工具条 / 显示模式类都要在新 body 上重建
    opts.renderer.setMode(opts.renderer.getMode());
    opts.ensureToolbar();
    clearTimeout(navTimer);
    navTimer = window.setTimeout(() => {
      if (document.visibilityState !== "visible") return; // 后台标签页等切回前台再译
      // 延迟窗口内用户手动还原了本页（restore 置 userRestored、state=off）：
      // 兜底重译必须让路——否则用户刚点完「还原」，200ms 后整页又被自动译回来
      if (opts.isPageDisabled() || (opts.engine.state === "off" && opts.engine.restoredByUser)) {
        return;
      }
      if (opts.autoTranslate || opts.engine.state !== "off") {
        if (!opts.isSensitive()) {
          void opts.engine.translateAll(); // 已还原/从未翻译/敏感页时不打扰用户
        }
      }
    }, SWAP_DELAY_MS);
  };

  // <body> 被整体替换（Turbo 等 SPA 框架）→ 换页（同一导航可能已被 pushState 处理过，会自动去重）
  opts.observer.onRootReplaced = () => handleNavigate("body 替换", true);

  // 浏览器前进/后退
  window.addEventListener("popstate", () => handleNavigate("popstate"));

  // bfcache 恢复（前进/后退由浏览器直接还原页面）：DOM 可能已带译文，无需重置，缺译文时补译
  window.addEventListener("pageshow", (e) => {
    opts.observer.rebind();
    if (e.persisted) {
      console.debug("[auto-translate] bfcache 恢复");
      if (
        document.visibilityState === "visible" &&
        (opts.autoTranslate || opts.engine.state !== "off") &&
        !opts.isSensitive() &&
        !opts.isPageDisabled() && // 用户明确禁用的子页：bfcache 回跳也不译回（同 SPA 延迟重译路径）
        !opts.engine.restoredByUser // 用户还原过的页面：bfcache 回跳也不自动译回（P0-2）
      ) {
        void opts.engine.translateAll();
      }
    }
  });

  // pushState / replaceState 补丁：拦截 SPA 程序化导航（点击换页通常是 pushState 先行）
  const origPushState = history.pushState.bind(history);
  const origReplaceState = history.replaceState.bind(history);
  history.pushState = ((...args: Parameters<History["pushState"]>) => {
    const r = origPushState(...args);
    handleNavigate("pushState");
    return r;
  }) as History["pushState"];
  history.replaceState = ((...args: Parameters<History["replaceState"]>) => {
    const r = origReplaceState(...args);
    handleNavigate("replaceState");
    return r;
  }) as History["replaceState"];

  // URL 轮询兜底：上面的信号都不触发时（框架直接改 location 等），也能发现换页
  window.setInterval(() => {
    if (location.href !== lastNavUrl) handleNavigate("URL 变化");
  }, URL_POLL_MS);
}
