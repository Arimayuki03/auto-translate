/** 阶段 4：content 装配层 —— 守卫 → 引擎 / 工具条 / 气泡 / 输入框 / 悬停翻译 / SPA 观察器
 *  manifest 开启 all_frames 后本脚本在每个 frame 注入：守卫（黑白名单/敏感页/子页禁用）
 *  按本 frame 自己的 URL 判断；引擎、观察器、样式、快捷键、自动翻译各 frame 独立生效；
 *  工具条、划词气泡、输入框翻译、SPA 导航接管是 top 专属装配。 */
import type { ItCommandMessage } from "../shared/messages";
import { resolveSiteRules } from "../shared/siteRules";
import type { ResolvedSiteRule } from "../shared/siteRules";
import { getSettings } from "../shared/storage";
import type { Settings } from "../shared/types";
import {
  currentHost,
  currentPageKey,
  getDisabledPages,
  getPerSite,
  setPageDisabled,
} from "./perSite";
import { PageEngine } from "./engine";
import { PageObserver } from "./observer";
import { Renderer } from "./renderer";
import { Toolbar } from "./toolbar";
import { initBubble } from "./bubble";
import { initInput } from "./input";
import { initHoverTranslate, isTopFrame } from "./hover";
import { applyTranslationStyle } from "./style";
import { setupSpaNavigation } from "./navigation";
import { installMasterSwitchSync, watchMasterSwitchReopen } from "./masterSwitch";

/**
 * 真正的凭据/敏感页关键词（保守名单，宁缺毋滥）：命中即整页跳过自动翻译。
 * 只在路径段的边界处匹配整词，避免误伤 —— 如 "security" 不会命中 "secure"、
 * "author" 不会命中 "auth"、"/settings/security" 正常翻译，而 "/account/password"、
 * "/security/two_factor_authentication" 会被跳过。
 */
const CREDENTIAL_RE =
  /(?:^|[/_.-])(?:login|log-?in|sign-?in|sign-?up|password|passwd|pwd|2fa|otp|mfa|totp|passkeys?|credentials?|wallet|secure|bank(?:ing)?|pay(?:ment)?|checkout|auth(?:entication|enticator|orization)?)(?:[/_.-]|$)/i;

async function main(): Promise<void> {
  const settings = await getSettings();
  if (!shouldTranslatePage(settings)) return; // 黑白名单命中：维持原语义（改动需刷新页面生效）
  if (!settings.enabled) {
    // 总开关关闭：不装配任何功能，只挂轻量监听等待重新开启（见 masterSwitch.ts）
    watchMasterSwitchReopen(() => void main());
    return;
  }
  await startTranslation(settings);
}

/** 完整装配（总开关开启且未被黑白名单拦截的 frame 才会走到这里）：
 *  引擎 / 工具条 / 划词气泡 / 输入框 / 悬停翻译 / 动态内容观察器 / 快捷键 / 自动翻译 */
async function startTranslation(settings: Settings): Promise<void> {
  // 顶层 / 子 frame 分流。window.top === window.self 在跨源下也只做引用比较，安全。
  const isTop = isTopFrame();

  // 当前 URL 是否为凭据/敏感页（登录/密码/2FA/支付等）。换页后动态重新判断（不是只判断一次）。
  // 子 frame 用自己的 URL：嵌入的登录/支付 iframe 即使父页正常也会被守卫拦下
  const isSensitive = (): boolean =>
    settings.security.sensitivePages &&
    CREDENTIAL_RE.test(location.hostname + " " + location.pathname);

  // 插件总开关的运行态镜像：装配完成后由下方 storage.onChanged 监听实时翻转。
  // 所有功能入口统一经 isBlocked 拦截（敏感页 或 开关关闭），保证关闭开关后
  // 快捷键/划词/输入框/悬停/观察器补扫/可见性触发翻译都不再有任何翻译动作。
  let enabledNow = settings.enabled;
  const isBlocked = (): boolean => !enabledNow || isSensitive();

  // 按站点还原上次的翻译设置（目标语言 / 显示模式）；换页后动态重新判断。
  // 每个 frame 各自按自己的 host 读取（子 frame 与父页站点不同时互不影响）
  const per = await getPerSite(currentHost());
  if (per) {
    settings.translate.targetLang = per.targetLang;
    settings.translate.displayMode = per.displayMode;
  }

  // 用户在该子网页点过「还原」→ 该子页禁用自动翻译。按 host+pathname 判断，只影响该子页，
  // 不影响同站其它子网页；同一内存 Set 供工具条实时增删、SPA 内切换无需重复读存储。
  const disabledPages = await getDisabledPages();
  const isPageDisabled = (): boolean => disabledPages.has(currentPageKey());

  const renderer = new Renderer(settings.translate.displayMode, settings.translate.targetLang);
  renderer.setMode(settings.translate.displayMode);
  // 译文样式主题 + 自定义 CSS（设置页配置；SPA 换页 body 被替换后也需重挂）
  const applyStyle = (): void =>
    applyTranslationStyle(settings.translate.style, settings.translate.customCss ?? "");
  applyStyle();
  // 站点规则库：内置规则 + 用户自定义规则按本 frame URL 合并解析（每 frame 独立，按各自 URL 匹配）。
  // SPA 换页不重跑 main()：导航回调里按新 URL 重解析（见 setupSpaNavigation 的 onNavigation）
  const resolveSiteRule = (): ResolvedSiteRule =>
    resolveSiteRules(
      location.href,
      settings.sites.rules ?? [],
      settings.sites.disabledRuleIds ?? []
    );
  const engine = new PageEngine(renderer, settings, resolveSiteRule());

  let toolbar: Toolbar | null = null;
  // 清理入口：总开关关闭时关掉划词气泡与输入框按钮、中止在途翻译请求
  // （气泡/输入框的关闭逻辑封闭在各自闭包内，initXxx 返回统一清理函数；
  //  子 frame 不装配这两者，保持 no-op）
  const closeBubble = isTop
    ? initBubble(engine, settings.translate.translateOnSelect, isBlocked, settings.tts)
    : () => {};
  const closeInput = isTop
    ? initInput(engine, settings.translate.translateInput, isBlocked)
    : () => {};
  if (isTop) {
    toolbar = new Toolbar(engine);
    toolbar.setSensitive(isBlocked()); // 敏感页 / 开关关闭时隐藏工具条

    console.debug("[auto-translate] content 已注入", {
      url: location.href,
      autoTranslate: settings.translate.autoTranslate,
      sensitive: isSensitive(),
      targetLang: settings.translate.targetLang,
      viewportLazy: settings.translate.viewportLazy,
    });

    // 悬停翻译：仅顶层 frame 且设置开启时装配；整页未翻译时悬停块级容器出「译」角标，点击只译该段
    if (settings.translate.translateHover) {
      initHoverTranslate({ engine, isSensitive: isBlocked });
    }
  } else {
    // 子 frame 注入日志精简：多 frame 页面会注入十几份，只留一行定位信息
    console.debug("[auto-translate] 子 frame 已注入", location.host + location.pathname);
  }

  const observer = new PageObserver(engine); // 构造即开始监听动态内容（各 frame 独立观察自己的 DOM）
  observer.isSensitive = isBlocked;
  observer.isPageDisabled = isPageDisabled;

  if (isTop) {
    // SPA 路由导航接管是 top 专属：子 frame 不补丁自己的 history，也不重建工具条
    // （子 frame 内的动态内容照常由 MutationObserver 兜住）
    setupSpaNavigation({
      engine,
      renderer,
      observer,
      autoTranslate: settings.translate.autoTranslate,
      isSensitive: isBlocked,
      isPageDisabled,
      // 带路径前缀的站点规则（matches/excludeMatches）随 SPA 换页按新 URL 重新解析
      onNavigation: () => engine.applySiteRule(resolveSiteRule()),
      ensureToolbar: () => {
        if (!document.querySelector(".it-toolbar")) {
          toolbar?.destroy(); // 工具条随旧 body 被移除，清理引用并重建
          toolbar = new Toolbar(engine);
        }
        toolbar?.setSensitive(isBlocked()); // 换页后按新 URL / 开关状态决定是否显示
        applyStyle(); // 新 body 上主题类已丢失，重挂（幂等）
      },
    });
  }

  // 快捷键（background 中继到当前标签页）。background 的 tabs.sendMessage 未指定 frameId，
  // 会广播到该标签页的所有 frame：每个 frame 各自 toggle 自己的引擎（cycle-mode 依赖工具条，
  // 仅顶层响应）
  chrome.runtime.onMessage.addListener((msg: ItCommandMessage) => {
    if (msg?.type !== "it-command") return;
    if (msg.command === "toggle-translate") {
      if (isBlocked()) return; // 敏感页 / 总开关关闭时禁止翻译
      // 判定口径与工具条 onToggle 一致：按整页状态机 state 而非 hasTranslated。
      // 悬停单译后 state 仍为 "off"，此时 Alt+T 应与工具条「译」一样翻译整页，
      // 而不是按 hasTranslated 误判为「已翻译」只还原那一段并禁用该页自动翻译。
      if (engine.state === "off") {
        void engine.translateAll(true); // 快捷键显式译回：属用户意图（P0-2）
        void setPageDisabled(currentPageKey(), false); // 翻译该子页 → 该子页恢复自动翻译
      } else {
        engine.restore();
        void setPageDisabled(currentPageKey(), true); // 还原该子页 → 该子页禁用自动翻译
      }
    } else if (msg.command === "cycle-mode" && toolbar) {
      if (isBlocked()) return; // 敏感页 / 总开关关闭：工具条本就隐藏，快捷键同样不应改显示模式
      toolbar.cycleMode();
    }
  });

  // 插件总开关实时生效（事件同步 + 装配窗口错过事件的快照回填，见 masterSwitch.ts）：
  // 关闭 → 还原本 frame 已译内容（同时中止在途请求，不浪费额度；不记用户还原意愿，
  //         重开后仍允许补译）、隐藏悬浮工具条、enabledNow 翻转后所有功能入口一律拦截；
  // 开启 → 恢复入口与工具条，并按自动翻译设置补译当前页。
  installMasterSwitchSync({
    getEnabled: () => enabledNow,
    setEnabled: (v) => {
      enabledNow = v;
    },
    onOff: () => {
      engine.restoreForSwitchOff();
      toolbar?.setSensitive(true); // 借用敏感页的隐藏机制收起悬浮工具条
      closeBubble(); // 关闭划词气泡 + 中止在途流式请求
      closeInput(); // 关闭输入框「译」按钮 + 丢弃在途单条翻译的回填
    },
    onOn: () => {
      toolbar?.setSensitive(isSensitive()); // 按当前 URL 恢复工具条显示状态
      if (
        settings.translate.autoTranslate &&
        document.visibilityState === "visible" &&
        !isSensitive() &&
        !isPageDisabled()
      ) {
        void engine.translateAll();
      }
    },
  });

  if (settings.translate.autoTranslate) {
    // 只翻译当前前台标签页；后台标签页等切到前台再译，避免后台抢 API 额度；敏感页/开关关闭跳过。
    // document.visibilityState 是各 frame 自己的可见性：display:none / 未渲染的子 frame 为
    // hidden，变为可见时会收到自己的 visibilitychange 再自动翻译（后台 frame 不抢额度）
    if (document.visibilityState === "visible" && !isBlocked() && !isPageDisabled()) {
      await engine.translateAll();
    }
    document.addEventListener("visibilitychange", () => {
      // 后台标签页切回前台再译；但用户已手动还原过本页 / 该子页被禁用 / 开关关闭时不重新翻译
      if (
        document.visibilityState === "visible" &&
        !isBlocked() &&
        !isPageDisabled() &&
        !engine.restoredByUser
      ) {
        void engine.translateAll(); // translateAll 元素级去重，无新内容时为 no-op
      }
    });
  }
}

/** 域名匹配：精确，或 host 是条目的子域（条目 github.com 覆盖 gist.github.com）。
 *  只做单向匹配：条目是 host 的子域时不匹配——黑名单条目 a.example.com 不应封禁整个
 *  example.com，白名单同理（否则给一个子域放行等于给整个主域放行）。 */
function matchesDomain(host: string, entry: string): boolean {
  const d = entry.toLowerCase().replace(/^www\./, "");
  return host === d || host.endsWith("." + d);
}

/** 页面级守卫：黑白名单（命中则整页禁用；敏感页判断改为动态，见 isSensitive）。
 *  总开关 enabled 不在这里判：关闭时 main 仍要挂 watchMasterSwitchReopen 监听，
 *  保证重新开启无需刷新页面。 */
function shouldTranslatePage(s: Settings): boolean {
  const host = location.hostname.replace(/^www\./, "").toLowerCase();

  if (s.sites.blacklist.some((d) => matchesDomain(host, d))) return false;
  if (s.sites.whitelist.length > 0 && !s.sites.whitelist.some((d) => matchesDomain(host, d))) {
    return false;
  }
  return true;
}

void main();
