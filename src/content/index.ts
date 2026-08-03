/** 阶段 4：content 装配层 —— 守卫 → 引擎 / 工具条 / 气泡 / 输入框 / 段落按钮 / SPA 观察器 */
import type { ItCommandMessage } from "../shared/messages";
import { getSettings } from "../shared/storage";
import type { Settings } from "../shared/types";
import { PageEngine } from "./engine";
import { PageObserver } from "./observer";
import { Renderer } from "./renderer";
import { Toolbar } from "./toolbar";
import { initBubble } from "./bubble";
import { initInput } from "./input";

/** 敏感页面路径启发式（保守名单，命中即跳过自动翻译） */
const SENSITIVE_RE =
  /(login|log-?in|signin|sign-?in|signup|sign-?up|auth|bank|banking|pay|payment|checkout|secure|2fa|otp|password|wallet)/i;

async function main(): Promise<void> {
  const settings = await getSettings();
  if (!shouldTranslatePage(settings)) return;

  const renderer = new Renderer(settings.translate.displayMode);
  renderer.setMode(settings.translate.displayMode);
  const engine = new PageEngine(renderer, settings);
  const toolbar = new Toolbar(engine);

  initBubble(engine, settings.translate.translateOnSelect);
  initInput(engine, settings.translate.translateInput);
  new PageObserver(engine); // 构造即开始监听 SPA 动态内容

  // 快捷键（background 中继到当前标签页）
  chrome.runtime.onMessage.addListener((msg: ItCommandMessage) => {
    if (msg?.type !== "it-command") return;
    if (msg.command === "toggle-translate") {
      if (engine.hasTranslated()) {
        engine.restore();
      } else {
        void engine.translateAll();
      }
    } else if (msg.command === "cycle-mode") {
      toolbar.cycleMode();
    }
  });

  if (settings.translate.autoTranslate) {
    // 只翻译当前前台标签页；后台标签页等切到前台再译，避免后台抢 API 额度
    if (document.visibilityState === "visible") {
      await engine.translateAll();
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        void engine.translateAll(); // translateAll 元素级去重，无新内容时为 no-op
      }
    });
  }
}

/** 页面级守卫：黑白名单 / 敏感页面（命中则整页禁用；autoTranslate 只控制是否自动翻译） */
function shouldTranslatePage(s: Settings): boolean {
  const host = location.hostname.replace(/^www\./, "").toLowerCase();

  if (s.sites.blacklist.some((d) => host.includes(d.toLowerCase()))) return false;
  if (
    s.sites.whitelist.length > 0 &&
    !s.sites.whitelist.some(
      (d) => host === d.toLowerCase() || host.endsWith("." + d.toLowerCase())
    )
  ) {
    return false;
  }
  if (s.security.sensitivePages && SENSITIVE_RE.test(location.hostname + " " + location.pathname)) {
    return false;
  }
  return true;
}

void main();
