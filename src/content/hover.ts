/** 悬停翻译：整页未翻译时，鼠标在「已排版的文字」上停留片刻，在其所在行左端显示「译」角标，
 *  点击只译该元素；已译（悬停单译过的）容器再悬停显示「还原」角标，点击只还原该段（engine.restoreElement）。
 *
 *  判定区域（2026-09 重写，修复「图标满屏乱弹」）：
 *  - 旧版从 e.target 向上找最近的块级候选（含 div/section 兜底），页面上几乎任何位置
 *    （空白区、卡片内边距、侧栏）都能命中某个装着 ≥20 字符的 div，角标随之乱跳；
 *  - 现在用 caret 命中测试：鼠标必须精确停在渲染出的文字字形上（命中点位于文本节点
 *    某行矩形内），且停留 HOVER_SHOW_DELAY_MS 才出角标——快速划动不会闪烁；
 *  - 角标锚在命中行的左端（划词气泡式的就近感），不再钉在大容器左上角；
 *  - 空白/图片/内边距 → 不出角标（但同一段落内穿字距不收起正在显示的角标）；
 *  - 环境无 caret API（jsdom 单测/极老旧内核）时回退旧的 target 判定，行为向后兼容。
 *
 *  纯叠加功能：角标显示与否的判定与引擎调度去重同一套口径
 *  （data-it-src / data-it-processing / isFailed / isScheduled / isSkipped），
 *  点击最终走 engine.translateElement / restoreElement，由引擎做权威去重，绝不绕过现有调度。
 */
import { extractUnits } from "./extractor";
import type { PageEngine } from "./engine";
import { placeFixedInViewport } from "./placement";
import { t } from "../shared/i18n";

/** 块级悬停候选：正文块直接作为候选；div/section 兜底——现在角标只在文字命中时出现，
 *  兜底只服务于「div 里直接写着文本」的组件页，不再从空白区误触发 */
const HOVER_BLOCK_SELECTOR =
  "p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,dd,dt,figcaption,div,section";

/** 候选元素至少包含的可见文本字符数：短元素不值得单独翻译 */
export const MIN_HOVER_TEXT_CHARS = 20;

/** 停留时长（ms）：鼠标在一行文字上停稳这么久才出角标。划词式交互的前提——
 *  扫读时鼠标会连续掠过大量文本行，无停留门槛就是「图标到处冒」的直接原因 */
export const HOVER_SHOW_DELAY_MS = 250;

/** 移出候选后角标延迟隐藏的窗口（ms）：鼠标去点角标的路上会先触发 mouseout，
 *  立即隐藏会让人永远点不中；窗口内回到候选或角标即取消隐藏 */
const HIDE_DELAY_MS = 300;

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

/** 命中译文结构（译文元素 / 包裹层）时解析回原文容器：包裹形态译文是原文容器的兄弟，
 *  经 .it-wrap>.it-orig 找回；行内 / 内部插入形态译文在容器内，closest [data-it-src] 即宿主 */
function resolveTranslatedHost(t: Element): HTMLElement | null {
  const wrap = t.closest(".it-wrap");
  if (wrap) {
    const orig = wrap.querySelector(":scope > .it-orig");
    if (orig instanceof HTMLElement) return orig;
  }
  const host = t.closest("[data-it-src]");
  return host instanceof HTMLElement ? host : null;
}

// ---- caret 命中测试：角标只在「鼠标压在渲染出的文字上」时出现 ----

export interface HoverCaretHit {
  /** 命中的文本节点（鼠标底下的那截文字） */
  node: Text;
  /** 命中点所在的行矩形（视口坐标）；环境无布局信息（jsdom）时为 null */
  rect: DOMRect | null;
}

/** caret 测试三态：hit=压在非空文字上；blank=不在任何渲染字形上（空白/图片/内边距/行缝）；
 *  unsupported=环境没有 caret API（单测等），调用方应回退 target 判定 */
export type HoverCaretResult =
  | { kind: "hit"; hit: HoverCaretHit }
  | { kind: "blank" }
  | { kind: "unsupported" };

/** 命中点所在行矩形：在文本节点的所有行矩形里找包住 (x,y) 的那一行（±1px 容差）。
 *  有矩形但一行都包不住 → null（caret API 在空白处会把光标「就近吸附」到别行的文字上，
 *  必须用矩形复核才能把 padding/图片上的假命中筛掉）；完全没有矩形（jsdom）→ null 且视为命中 */
function caretLineRect(node: Text, x: number, y: number): { rect: DOMRect | null; measurable: boolean } {
  const range = document.createRange();
  range.selectNodeContents(node);
  // 无布局环境（jsdom 等）Range 根本没有这个 API：视为不可测量而非报错
  if (typeof range.getClientRects !== "function") return { rect: null, measurable: false };
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  if (rects.length === 0) return { rect: null, measurable: false };
  const hit = rects.find(
    (r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1
  );
  return { rect: hit ?? null, measurable: true };
}

export function caretHitAt(x: number, y: number): HoverCaretResult {
  let node: Node | null = null;
  const crfp = (
    document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
  ).caretRangeFromPoint;
  if (typeof crfp === "function") {
    // Chrome / Edge / Safari（非标准但实现一致）
    node = crfp.call(document, x, y)?.startContainer ?? null;
  } else if (typeof document.caretPositionFromPoint === "function") {
    // Firefox / 标准 API
    node = document.caretPositionFromPoint(x, y)?.offsetNode ?? null;
  } else {
    return { kind: "unsupported" };
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return { kind: "blank" };
  const text = node as Text;
  if (!(text.textContent ?? "").trim()) return { kind: "blank" }; // 纯空白文本节点不算压在字上
  const { rect, measurable } = caretLineRect(text, x, y);
  if (measurable && !rect) return { kind: "blank" }; // 命中点其实不在这一行的字距里
  return { kind: "hit", hit: { node: text, rect } };
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
 *  过滤已译/在途/失败/已调度/同文已译后还有新鲜单元，角标才值得显示。
 *  提取含 shadow 收集与样式读取，悬停扫过大 div/section 开销可观——
 *  只在角标真正要弹出时（停留到期）跑一次；结果再按元素缓存 1s。
 *  已译/在途元素在此之前已被 isHoverExcluded 的 data-it-src/processing 拦下，不受缓存影响。 */
const freshUnitsCache = new WeakMap<HTMLElement, { at: number; ok: boolean }>();
const FRESH_CACHE_TTL_MS = 1000;

function hasFreshUnits(el: HTMLElement, engine: PageEngine): boolean {
  const cached = freshUnitsCache.get(el);
  const now = Date.now();
  if (cached && now - cached.at < FRESH_CACHE_TTL_MS) return cached.ok;
  const ok = extractUnits(el, engine.extractOptions).some(
    (u) =>
      !u.container.hasAttribute("data-it-src") &&
      !u.container.hasAttribute("data-it-processing") &&
      !engine.renderer.isFailed(u.container) &&
      !engine.isScheduled(u.container) &&
      !engine.isSkipped(u.text)
  );
  freshUnitsCache.set(el, { at: now, ok });
  return ok;
}

/** 轻量门控（调度停留计时前跑，纯 DOM）：敏感页 / 整页翻译状态 / 排除规则 */
function quickEligible(el: HTMLElement, isSensitive: () => boolean, engine: PageEngine): boolean {
  if (isSensitive()) return false;
  // 整页已翻译/翻译中则不再出角标（悬停单译不推状态机，见 engine.suppressPageState）；
  // 还原 / SPA 换页后 hasTranslated 归零，角标自动恢复
  if (engine.state !== "off" && engine.hasTranslated()) return false;
  return !isHoverExcluded(el);
}

/** 停留到期的最终校验（含引擎提取预判） */
function isEligibleCandidate(
  el: HTMLElement,
  engine: PageEngine,
  isSensitive: () => boolean
): boolean {
  if (!quickEligible(el, isSensitive, engine)) return false;
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
  badge.textContent = t("translate");
  badge.style.display = "none";
  // 挂 <html> 而非 body：body 带 transform/filter 的站点上 fixed 包含块会失真（见 placement.ts）
  (document.documentElement ?? document.body).appendChild(badge);

  let current: HTMLElement | null = null;
  let hideTimer: number | undefined;
  let showTimer: number | undefined;
  /** 停留计时中的候选：到期时重新校验再弹出（期间页面状态可能已变） */
  let pending: { el: HTMLElement; restore: boolean; anchor: DOMRect | null } | null = null;

  const clearHideTimer = (): void => {
    if (hideTimer !== undefined) {
      window.clearTimeout(hideTimer);
      hideTimer = undefined;
    }
  };

  const clearShowTimer = (): void => {
    if (showTimer !== undefined) {
      window.clearTimeout(showTimer);
      showTimer = undefined;
    }
  };

  const hide = (): void => {
    clearHideTimer();
    clearShowTimer();
    pending = null;
    if (!current) return;
    current = null;
    badge.style.display = "none";
  };

  /** 延迟隐藏：移出候选（穿缝去点角标、划过邻近空白）先挂起，HIDE_DELAY_MS 内无回访再收 */
  const scheduleHide = (): void => {
    if (!current) return;
    clearHideTimer();
    hideTimer = window.setTimeout(hide, HIDE_DELAY_MS);
  };

  const show = (el: HTMLElement, restore: boolean, anchor: DOMRect | null): void => {
    clearHideTimer();
    clearShowTimer();
    pending = null;
    let r = anchor;
    // 命中行矩形测不到（jsdom/刚移出视口）：退回候选块左上角
    if (!r || r.width <= 0 || r.height <= 0) r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      hide(); // 无几何信息（未渲染）：不残留上一个候选的角标
      return;
    }
    badge.textContent = restore ? t("restore") : t("translate");
    // 角标贴命中行左端内侧：与文字零缝隙，鼠标原位微动即可点中；顶到视口边缘时收进视口
    const x = Math.min(Math.max(r.left + 2, 4), Math.max(4, window.innerWidth - 44));
    const y = Math.min(Math.max(r.top + 2, 4), Math.max(4, window.innerHeight - 24));
    // 先可见再定位：placeFixedInViewport 要读回实际渲染位置校正含块偏移（站点 body/html 带 transform 时 fixed 不以视口为包含块）
    badge.style.display = "block";
    placeFixedInViewport(badge, x, y);
    current = el;
  };

  /** 停留达标才真正弹出：调度时只记候选，到期重查一切状态 */
  const scheduleShow = (el: HTMLElement, restore: boolean, anchor: DOMRect | null): void => {
    // 同一候选的停留已在计时（块内跨 span 移动会连续触发 mouseover）：续着计，不重头再来；
    // 锚点刷新为最新命中行——停留期间布局可能变化（字体换上/图片加载），旧矩形会飘
    if (pending && pending.el === el) {
      if (anchor) pending.anchor = anchor;
      return;
    }
    clearShowTimer();
    pending = { el, restore, anchor };
    showTimer = window.setTimeout(() => {
      showTimer = undefined;
      const p = pending;
      pending = null;
      if (!p || !p.el.isConnected) return;
      if (p.restore) {
        // 停留期间被还原/又重译：还原角标语义失效，收起
        if (!p.el.hasAttribute("data-it-src") || p.el.hasAttribute("data-it-processing")) return;
        if (isSensitive() || (engine.state !== "off" && engine.hasTranslated())) return;
        show(p.el, true, p.anchor);
        return;
      }
      if (!isEligibleCandidate(p.el, engine, isSensitive)) return;
      show(p.el, false, p.anchor);
    }, HOVER_SHOW_DELAY_MS);
  };

  /** 空白/图片/控件上的命中：若仍在当前候选（或停留计时中的候选）内部——穿字距、跨行缝——
   *  不打扰角标；否则收起 */
  const keepOrHide = (from: Element): void => {
    const c = findHoverCandidate(from);
    if (c && (c === current || pending?.el === c)) {
      clearHideTimer();
      return;
    }
    clearShowTimer();
    pending = null;
    hide();
  };

  const onMouseOver = (e: MouseEvent): void => {
    // 划词选择进行中不出角标（与划词气泡互不干扰，也不挡选择）；
    // 停留计时/已显示的角标一并取消——选择开始意味着用户意图变为划词
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      hide();
      return;
    }
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest("[data-it-ui]")) {
      // 悬停到角标自身：取消在途的隐藏/调度，角标保持不动
      clearHideTimer();
      clearShowTimer();
      return;
    }
    if (t.closest(INTERACTIVE_SELECTOR)) {
      hide(); // 交互/可编辑元素上不出角标，不干扰点击
      return;
    }

    let cand: HTMLElement | null;
    let anchor: DOMRect | null = null;
    const caret = caretHitAt(e.clientX, e.clientY);
    if (caret.kind === "blank") {
      keepOrHide(t); // 空白/图片/内边距：绝不为它弹角标
      return;
    }
    if (caret.kind === "hit") {
      const start = caret.hit.node.parentElement;
      if (!start) {
        keepOrHide(t);
        return;
      }
      if (start.closest("[data-it-ui]")) {
        clearHideTimer();
        clearShowTimer();
        return; // 命中我们自己的 UI 文字（如角标/气泡内）：保持现状
      }
      if (start.closest(INTERACTIVE_SELECTOR)) {
        keepOrHide(t); // 控件里的文字（按钮题图等）不出角标
        return;
      }
      // 命中译文结构（译文元素 / 包裹层 / 原文容器在包裹层内）：解析回原文容器
      const onTranslation = !!start.closest(".it-translated, .it-wrap, [data-it-src]");
      cand = onTranslation ? resolveTranslatedHost(start) : findHoverCandidate(start);
      anchor = caret.hit.rect;
      if (!cand) {
        keepOrHide(start); // 孤儿文字（不属于任何候选块）：不打扰当前角标
        return;
      }
    } else {
      // 无 caret API：回退旧的 target 判定（单测环境保持原语义）
      const onTranslation = !!t.closest(".it-translated, .it-wrap");
      cand = onTranslation ? resolveTranslatedHost(t) : findHoverCandidate(t);
    }

    if (cand && cand === current) {
      clearHideTimer(); // 移回当前候选：取消在途的延迟隐藏，角标保持不动
      clearShowTimer();
      return;
    }
    if (cand && cand.hasAttribute("data-it-src") && !cand.hasAttribute("data-it-processing")) {
      // 已译候选 →「还原」角标：敏感页 / 整页翻译中不出，与「译」入口同一门控
      if (isSensitive() || (engine.state !== "off" && engine.hasTranslated())) {
        hide();
        return;
      }
      scheduleShow(cand, true, anchor);
      return;
    }
    if (!cand || !cand.isConnected || !quickEligible(cand, isSensitive, engine)) {
      clearShowTimer();
      pending = null;
      hide();
      return;
    }
    // 切到别的候选：先收起旧角标，再对新候选计停留——杜绝「扫一眼满屏角标乱跳」
    if (current) hide();
    scheduleShow(cand, false, anchor);
  };

  const onMouseOut = (e: MouseEvent): void => {
    const to = e.relatedTarget;
    // 停留计时中的候选被移出（含移出窗口）：dwell 作废，否则鼠标离开后角标仍会到期弹出
    if (pending) {
      const stillInside =
        to instanceof Element &&
        (pending.el.contains(to) || badge.contains(to));
      if (!stillInside) {
        clearShowTimer();
        pending = null;
      }
    }
    if (!current) return;
    // 移入同一候选内部或角标自身都保持显示
    if (to instanceof Element && (current.contains(to) || badge.contains(to))) return;
    scheduleHide(); // 其余移出场景延迟收：给去点角标的鼠标留时间
  };

  const onBadgeClick = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const el = current;
    // 已译 → 还原该段；未译 → 翻译该段。在途（processing）不可能成为 current（显示时已排除）
    const restore = !!el?.hasAttribute("data-it-src");
    hide();
    if (!el || !el.isConnected) return;
    freshUnitsCache.delete(el); // 译↔原状态刚翻转，悬停预判缓存（1s TTL）立即失效
    if (restore) engine.restoreElement(el);
    else engine.translateElement(el);
  };

  // 滚动后元素位置已变：直接隐藏（含取消在途调度），等下一次 mouseover 重新定位
  const onScroll = (): void => hide();

  document.addEventListener("mouseover", onMouseOver);
  document.addEventListener("mouseout", onMouseOut);
  badge.addEventListener("click", onBadgeClick);
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });

  return () => {
    clearHideTimer();
    clearShowTimer();
    document.removeEventListener("mouseover", onMouseOver);
    document.removeEventListener("mouseout", onMouseOut);
    badge.removeEventListener("click", onBadgeClick);
    window.removeEventListener("scroll", onScroll, { capture: true });
    badge.remove();
  };
}
