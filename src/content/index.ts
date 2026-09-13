/** 阶段 4：content 装配层 —— 守卫 → 引擎 / 工具条 / 气泡 / 输入框 / 段落按钮 / SPA 观察器 */
import type { ItCommandMessage } from "../shared/messages";
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
import { applyTranslationStyle } from "./style";
import { setupSpaNavigation } from "./navigation";

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
  if (!shouldTranslatePage(settings)) return;

  // 当前 URL 是否为凭据/敏感页（登录/密码/2FA/支付等）。换页后动态重新判断（不是只判断一次）。
  const isSensitive = (): boolean =>
    settings.security.sensitivePages &&
    CREDENTIAL_RE.test(location.hostname + " " + location.pathname);

  // 按站点还原上次的翻译设置（目标语言 / 显示模式）；换页后动态重新判断
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
  const engine = new PageEngine(renderer, settings);
  let toolbar = new Toolbar(engine);
  toolbar.setSensitive(isSensitive()); // 敏感页隐藏工具条

  console.debug("[auto-translate] content 已注入", {
    url: location.href,
    autoTranslate: settings.translate.autoTranslate,
    sensitive: isSensitive(),
    targetLang: settings.translate.targetLang,
    viewportLazy: settings.translate.viewportLazy,
  });

  initBubble(engine, settings.translate.translateOnSelect, isSensitive);
  initInput(engine, settings.translate.translateInput, isSensitive);
  const observer = new PageObserver(engine); // 构造即开始监听 SPA 动态内容
  observer.isSensitive = isSensitive;
  observer.isPageDisabled = isPageDisabled;

  // SPA 路由导航：换页时重置引擎状态 → 重建工具条（body 被替换时会消失）→ 延迟重译新页面
  setupSpaNavigation({
    engine,
    renderer,
    observer,
    autoTranslate: settings.translate.autoTranslate,
    isSensitive,
    isPageDisabled,
    ensureToolbar: () => {
      if (!document.querySelector(".it-toolbar")) {
        toolbar.destroy(); // 工具条随旧 body 被移除，清理引用并重建
        toolbar = new Toolbar(engine);
      }
      toolbar.setSensitive(isSensitive()); // 换页后按新 URL 决定是否显示
      applyStyle(); // 新 body 上主题类已丢失，重挂（幂等）
    },
  });

  // 快捷键（background 中继到当前标签页）
  chrome.runtime.onMessage.addListener((msg: ItCommandMessage) => {
    if (msg?.type !== "it-command") return;
    if (msg.command === "toggle-translate") {
      if (isSensitive()) return; // 敏感页禁止翻译
      if (engine.hasTranslated()) {
        engine.restore();
        void setPageDisabled(currentPageKey(), true); // 还原该子页 → 该子页禁用自动翻译
      } else {
        void engine.translateAll();
        void setPageDisabled(currentPageKey(), false); // 翻译该子页 → 该子页恢复自动翻译
      }
    } else if (msg.command === "cycle-mode") {
      toolbar.cycleMode();
    }
  });

  if (settings.translate.autoTranslate) {
    // 只翻译当前前台标签页；后台标签页等切到前台再译，避免后台抢 API 额度；敏感页跳过
    if (document.visibilityState === "visible" && !isSensitive() && !isPageDisabled()) {
      await engine.translateAll();
    }
    document.addEventListener("visibilitychange", () => {
      // 后台标签页切回前台再译；但用户已手动还原过本页 / 该子页被禁用时不重新翻译
      if (
        document.visibilityState === "visible" &&
        !isSensitive() &&
        !isPageDisabled() &&
        !engine.restoredByUser
      ) {
        void engine.translateAll(); // translateAll 元素级去重，无新内容时为 no-op
      }
    });
  }
}

/** 域名匹配：精确，或互为子域名（github.com ↔ gist.github.com 等） */
function matchesDomain(host: string, entry: string): boolean {
  const d = entry.toLowerCase().replace(/^www\./, "");
  if (host === d) return true;
  return host.endsWith("." + d) || d.endsWith("." + host);
}

/** 页面级守卫：黑白名单（命中则整页禁用；敏感页判断改为动态，见 isSensitive） */
function shouldTranslatePage(s: Settings): boolean {
  const host = location.hostname.replace(/^www\./, "").toLowerCase();

  if (s.sites.blacklist.some((d) => matchesDomain(host, d))) return false;
  if (s.sites.whitelist.length > 0 && !s.sites.whitelist.some((d) => matchesDomain(host, d))) {
    return false;
  }
  return true;
}

void main();
