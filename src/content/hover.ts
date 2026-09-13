/** 悬停翻译：整页未翻译时，鼠标悬停块级文本容器，在其左上角显示「译」角标，点击只译该元素。
 *  纯叠加功能：不新增设置项；角标显示与否的判定与引擎调度去重同一套口径
 *  （data-it-src / data-it-processing / isFailed / isScheduled / isSkipped），
 *  点击最终走 engine.translateElement，由引擎做权威去重，绝不绕过现有调度。
 */
import { extractUnits } from "./extractor";
import type { PageEngine } from "./engine";

/** 块级悬停候选：正文块直接作为候选；div/section 为兜底（悬停其空白处可整块译入） */
const HOVER_BLOCK_SELECTOR =
  "p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,dd,dt,figcaption,div,section";

/** 候选元素至少包含的可见文本字符数：短元素不值得单独翻译 */
export const MIN_HOVER_TEXT_CHARS = 20;

/** 表单控件 / 可编辑区：悬停其上不出角标（输入框翻译另有入口），点击不被干扰 */
const INTERACTIVE_SELECTOR =
  "input,textarea,select,option,button,[contenteditable='true'],[contenteditable='']";

/** 是否顶层 frame。跨源下 window.top 只允许引用比较（不会 throw），try 兜底沙箱异常 */
export function isTopFrame(win: Window = window): boolean {
  try {
    return win.top === win.self;
  } catch {
    return true;
  }
}

/** 从鼠标命中元素（含自身）向上找最近的块级悬停候选 */
export function findHoverCandidate(from: Element | null): HTMLElement | null {
  if (!from || from.nodeType !== Node.ELEMENT_NODE) return null;
  return from.closest<HTMLElement>(HOVER_BLOCK_SELECTOR);
}

/** 排除规则（纯 DOM 判定，不含引擎状态）：我们自己的 UI 与译文结构、表单/可编辑区、
 *  aria-hidden、视觉隐藏、短文本。已译/在途/失败/同文已译交给引擎口径（见 hasFreshUnits） */
export function isHoverExcluded(el: Element): boolean {
  // 我们的 UI（工具条/气泡/角标/样式注入）与已渲染的译文结构
  if (el.closest("[data-it-ui],[data-it-unit],.it-translated,.it-wrap")) return true;
  // 已译/在途容器（与引擎去重标记一致；译文结构上面的 closest 已覆盖大多数情况）
  if (el.hasAttribute("data-it-src") || el.hasAttribute("data-it-processing")) return true;
  // 表单控件与可编辑区
  if (el.closest(INTERACTIVE_SELECTOR)) return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.closest('[aria-hidden="true"]')) return true;
  if (isHoverHidden(el)) return true;
  if ((el.textContent ?? "").trim().length < MIN_HOVER_TEXT_CHARS) return true;
  return false;
}

/** 视觉隐藏：hidden 属性 / display:none / visibility:hidden */
function isHoverHidden(el: Element): boolean {
  if ((el as HTMLElement).hidden) return true;
  const cs = getComputedStyle(el);
  return cs.display === "none" || cs.visibility === "hidden";
}

/** 与引擎调度完全相同的去重口径预判：对候选做一次单元素提取，
 *  过滤已译/在途/失败/已调度/同文已译后还有新鲜单元，角标才值得显示 */
function hasFreshUnits(el: HTMLElement, engine: PageEngine): boolean {
  return extractUnits(el, engine.extractOptions).some(
    (u) =>
      !u.container.hasAttribute("data-it-src") &&
      !u.container.hasAttribute("data-it-processing") &&
      !engine.renderer.isFailed(u.container) &&
      !engine.isScheduled(u.container) &&
      !engine.isSkipped(u.text)
  );
}

/** 候选是否可出角标：敏感页 / 整页翻译状态 / 排除规则 / 引擎同口径预判 */
function isEligibleCandidate(
  el: HTMLElement,
  engine: PageEngine,
  isSensitive: () => boolean
): boolean {
  if (isSensitive()) return false;
  // 整页已翻译/翻译中则不再出角标（悬停单译不推状态机，见 engine.suppressPageState）；
  // 还原 / SPA 换页后 hasTranslated 归零，角标自动恢复
  if (engine.state !== "off" && engine.hasTranslated()) return false;
  if (isHoverExcluded(el)) return false;
  return hasFreshUnits(el, engine);
}

export interface HoverTranslateOptions {
  engine: PageEngine;
  /** 当前 URL 是否敏感页（动态判断）：敏感页永不出角标 */
  isSensitive: () => boolean;
}

/** 装配悬停翻译。返回清理函数（移除监听与角标），供测试与未来卸载使用 */
export function initHoverTranslate(opts: HoverTranslateOptions): () => void {
  const { engine, isSensitive } = opts;
  if (!document.body) return () => undefined;

  const badge = document.createElement("div");
  badge.className = "it-hover-badge";
  badge.setAttribute("data-it-ui", ""); // 提取/观察器/悬停判定统一跳过我们自己的 UI
  badge.textContent = "译";
  badge.style.display = "none";
  document.body.appendChild(badge);

  let current: HTMLElement | null = null;

  const hide = (): void => {
    if (!current) return;
    current = null;
    badge.style.display = "none";
  };

  const show = (el: HTMLElement): void => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      hide(); // 无几何信息（未渲染）：不残留上一个候选的角标
      return;
    }
    // 角标贴候选左上角外侧；元素顶到视口上沿时放进内部，避免被视口裁掉
    const x = Math.min(Math.max(r.left, 4), Math.max(4, window.innerWidth - 28));
    const y = r.top >= 26 ? r.top - 24 : r.top + 2;
    badge.style.left = `${Math.round(x)}px`;
    badge.style.top = `${Math.round(y)}px`;
    badge.style.display = "block";
    current = el;
  };

  const onMouseOver = (e: MouseEvent): void => {
    // 划词选择进行中不出角标（与划词气泡互不干扰，也不挡选择）
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest("[data-it-ui]")) return; // 悬停在我们 UI（含角标）上：保持现状
    if (t.closest(INTERACTIVE_SELECTOR)) {
      hide(); // 交互/可编辑元素上不出角标，不干扰点击
      return;
    }
    const cand = findHoverCandidate(t);
    if (cand && cand === current) return; // 同一块内移动：角标保持不动
    if (!cand || !cand.isConnected || !isEligibleCandidate(cand, engine, isSensitive)) {
      hide();
      return;
    }
    show(cand);
  };

  const onMouseOut = (e: MouseEvent): void => {
    if (!current) return;
    const to = e.relatedTarget;
    // 移入同一候选内部或角标自身都保持显示
    if (to instanceof Element && (current.contains(to) || badge.contains(to))) return;
    hide();
  };

  const onBadgeClick = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const el = current;
    hide();
    if (!el || !el.isConnected) return;
    engine.translateElement(el);
  };

  // 滚动后元素位置已变：直接隐藏，等下一次 mouseover 重新定位，避免角标飘在错误位置
  const onScroll = (): void => hide();

  document.addEventListener("mouseover", onMouseOver);
  document.addEventListener("mouseout", onMouseOut);
  badge.addEventListener("click", onBadgeClick);
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });

  return () => {
    document.removeEventListener("mouseover", onMouseOver);
    document.removeEventListener("mouseout", onMouseOut);
    badge.removeEventListener("click", onBadgeClick);
    window.removeEventListener("scroll", onScroll, { capture: true });
    badge.remove();
  };
}
