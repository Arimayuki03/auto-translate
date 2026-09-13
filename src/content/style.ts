/** 译文样式主题：body 主题类切换 + 用户自定义 CSS 注入（设置页配置，下次注入页面生效） */
import type { TranslationStyle } from "../shared/types";

/** 合法主题（未知值回退 gray） */
const STYLES: ReadonlySet<TranslationStyle> = new Set(["gray", "outline", "underline", "blur"]);

const STYLE_CLASS_PREFIX = "it-style-";
/** 自定义 CSS 上限：足够写整套译文样式，同时防异常导入撑爆样式表 */
const MAX_CUSTOM_CSS = 8000;

/** 移除旧主题类 → 挂新主题类（CSS 按 body.it-style-* 作用域生效） */
function applyStyleClass(style: TranslationStyle): void {
  const body = document.body;
  if (!body) return;
  for (const s of STYLES) body.classList.remove(STYLE_CLASS_PREFIX + s);
  body.classList.add(STYLE_CLASS_PREFIX + (STYLES.has(style) ? style : "gray"));
}

/** 自定义 CSS 只作用译文层：剥掉 </style> 闭合序列防逃逸，限长防异常导入 */
function sanitizeCustomCss(css: string): string {
  return css.replace(/<\/style/gi, "").slice(0, MAX_CUSTOM_CSS);
}

/** 应用译文样式：主题类挂 body + 自定义 CSS 注入 <style data-it-ui>（幂等，可重复调用） */
export function applyTranslationStyle(style: TranslationStyle | undefined, customCss: string): void {
  applyStyleClass(style ?? "gray");
  const css = sanitizeCustomCss(customCss ?? "");
  let el = document.getElementById("it-custom-style") as HTMLStyleElement | null;
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = "it-custom-style";
    el.setAttribute("data-it-ui", ""); // 标记我们的 UI，提取/观察器跳过
    document.head.appendChild(el);
  }
  el.textContent = css;
}
