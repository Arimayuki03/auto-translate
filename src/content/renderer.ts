/** 译文渲染 / 模式切换 / 一键还原
 *  核心架构：块级译文用「包裹原块」——.it-wrap 顶替原元素在布局中的位置，
 *  译文作为兄弟放在包裹层内，不新增父级布局项，避免 flex/grid/表格被挤变形。
 *  列表/表格项（li/td）不能包，退回「插内部」；导航/页脚等紧凑标签用「行内」。
 */
import type { DisplayMode } from "../shared/types";
import type { TranslationUnit } from "./extractor";

/** 父级为这些标签时译文插到容器内部（块级兄弟会破坏列表/表格结构） */
const RESTRICTED_PARENTS = new Set([
  "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "COLGROUP",
  "UL", "OL", "DL", "MENU",
]);

/** 元素自身是列表/表格项，不能包（包裹层会成为其父级的非法子元素） */
const NON_WRAPPABLE = new Set(["LI", "TD", "TH", "DD", "DT", "TR", "CAPTION"]);

export class Renderer {
  private mode: DisplayMode;
  /** 容器 → 当前译文/占位元素（包裹内或行内） */
  private byContainer = new Map<HTMLElement, HTMLElement>();

  constructor(mode: DisplayMode) {
    this.mode = mode;
  }

  /** 预留译文空间：插入不可见占位（估算高度），填充时不引起页面跳动 */
  reserve(unit: TranslationUnit): void {
    if (!unit.container.isConnected) return; // 容器已被页面移除，丢弃
    if (this.byContainer.has(unit.container)) return;
    const el = document.createElement("span");
    el.className = "it-translated it-pending";
    el.setAttribute("data-it-unit", unit.id);
    el.style.minHeight = estimateHeight(unit);
    this.insert(unit, el);
    this.byContainer.set(unit.container, el);
    this.ensureTranslatedHidden(unit.container);
  }

  /** 译文就绪：填充（复用占位，无占位或占位失效时新建插入） */
  fill(unit: TranslationUnit, chunkResults: string[]): void {
    if (!unit.container.isConnected) return; // 回填校验：容器被页面改动/移除则丢弃
    let el = this.byContainer.get(unit.container);
    if (!el || !el.isConnected) {
      this.byContainer.delete(unit.container);
      el = document.createElement("span");
      el.className = "it-translated it-done";
      el.setAttribute("data-it-unit", unit.id);
      this.insert(unit, el);
      this.byContainer.set(unit.container, el);
    }
    el.classList.remove("it-pending", "it-error");
    el.classList.add("it-done");
    el.style.minHeight = "";
    el.textContent = "";
    if (isCompactUILabel(unit)) {
      el.classList.add("it-inline");
      el.textContent = chunkResults.map((c) => c.trim()).join(" / ");
    } else {
      for (const chunk of chunkResults) {
        const s = document.createElement("span");
        s.className = "it-chunk";
        s.textContent = chunk.trim();
        el.appendChild(s);
      }
    }
    this.ensureTranslatedHidden(unit.container);
  }

  /** 翻译失败：复用占位或新建，转为错误态 */
  fail(unit: TranslationUnit): void {
    if (!unit.container.isConnected) return;
    let el = this.byContainer.get(unit.container);
    if (!el || !el.isConnected) {
      this.byContainer.delete(unit.container);
      el = document.createElement("span");
      el.className = "it-translated it-error";
      el.setAttribute("data-it-unit", unit.id);
      this.insert(unit, el);
      this.byContainer.set(unit.container, el);
    }
    el.classList.remove("it-pending", "it-done");
    el.classList.add("it-error");
    el.style.minHeight = "";
    el.textContent = "";
    const span = document.createElement("span");
    span.className = "it-err-text";
    span.textContent = "翻译失败";
    const retry = document.createElement("button");
    retry.className = "it-retry";
    retry.textContent = "重试";
    retry.setAttribute("data-it-unit", unit.id);
    el.append(span, retry);
  }

  /** 重试前：移除旧内容（解包原文），回到未译状态 */
  retryState(unit: TranslationUnit): void {
    this.clearContainer(unit.container);
  }

  getMode(): DisplayMode {
    return this.mode;
  }

  /** 切换显示模式：body 类控制可见性；inside 容器的直接文本用 JS 隐藏 */
  setMode(mode: DisplayMode): void {
    this.mode = mode;
    if (mode === "translated") {
      for (const container of this.byContainer.keys()) this.ensureTranslatedHidden(container);
    } else {
      this.restoreOriginalTexts();
    }
    document.body.classList.toggle("it-mode-translated", mode === "translated");
    document.body.classList.toggle("it-mode-original", mode === "original");
  }

  /** 一键还原：解包把原文移回原位，移除全部译文与标记 */
  restore(): void {
    this.restoreOriginalTexts();
    // 解包：原文移回原位，译文随包裹层一起移除
    document.querySelectorAll(".it-wrap").forEach((wrap) => {
      const orig = wrap.querySelector(":scope > .it-orig");
      if (orig) wrap.before(orig);
      wrap.remove();
    });
    // 清理非包裹的译文（行内/内部插入）
    document.querySelectorAll("[data-it-unit]").forEach((n) => n.remove());
    document.querySelectorAll("[data-it-src]").forEach((n) => n.removeAttribute("data-it-src"));
    document.querySelectorAll("[data-it-processing]").forEach((n) =>
      n.removeAttribute("data-it-processing")
    );
    document.querySelectorAll("[data-it-inside]").forEach((n) => n.removeAttribute("data-it-inside"));
    document.querySelectorAll(".it-orig").forEach((n) => n.classList.remove("it-orig"));
    document.body.classList.remove("it-mode-translated", "it-mode-original");
    this.byContainer.clear();
  }

  /** 插入译文/占位：紧凑标签行内；可包的块级元素包裹；li/td 等插内部 */
  private insert(unit: TranslationUnit, el: HTMLElement): void {
    const container = unit.container;
    container.setAttribute("data-it-src", "");
    if (isCompactUILabel(unit)) {
      this.attachInline(container, el);
    } else if (canWrap(container)) {
      this.wrapContainer(container, el);
    } else {
      container.setAttribute("data-it-inside", "");
      container.appendChild(el);
    }
  }

  /** 包裹：把原文容器移进 .it-wrap（顶替原位置），译文作为兄弟 */
  private wrapContainer(container: HTMLElement, el: HTMLElement): void {
    const wrap = document.createElement("div");
    wrap.className = "it-wrap";
    wrap.setAttribute("data-it-unit", el.getAttribute("data-it-unit") ?? "");
    container.before(wrap);
    wrap.appendChild(container);
    wrap.appendChild(el);
    container.classList.add("it-orig");
  }

  /** 行内译文：链接插到后面；li/其他文本块插到内部，与原文并排 */
  private attachInline(container: HTMLElement, el: HTMLElement): void {
    if (container.tagName === "A") {
      container.after(el);
    } else {
      container.setAttribute("data-it-inside", "");
      container.appendChild(el);
    }
  }

  private clearContainer(container: HTMLElement): void {
    const prev = this.byContainer.get(container);
    if (prev) {
      const wrap = prev.closest(".it-wrap");
      if (wrap) {
        const orig = wrap.querySelector(":scope > .it-orig");
        if (orig) wrap.before(orig);
        wrap.remove();
      } else {
        prev.remove();
      }
      this.byContainer.delete(container);
    }
    container.removeAttribute("data-it-src");
  }

  /** 仅译文：把 inside 容器的直接文本节点（原文）包进隐藏 span（CSS 无法选中直接文本） */
  private ensureTranslatedHidden(container: HTMLElement): void {
    if (this.mode !== "translated" || !container.hasAttribute("data-it-inside")) return;
    for (const child of Array.from(container.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
        const wrap = document.createElement("span");
        wrap.className = "it-orig-text";
        wrap.style.display = "none";
        child.replaceWith(wrap);
        wrap.appendChild(child);
      }
    }
  }

  /** 离开仅译文：还原被包裹的原文文本节点 */
  private restoreOriginalTexts(): void {
    document.querySelectorAll(".it-orig-text").forEach((wrap) => {
      wrap.replaceWith(...Array.from(wrap.childNodes));
    });
  }
}

/** 能否用 .it-wrap 包裹该容器：块级流内容且父级允许 div 子元素 */
function canWrap(container: HTMLElement): boolean {
  if (NON_WRAPPABLE.has(container.tagName)) return false;
  const parent = container.parentElement;
  if (!parent) return false;
  if (RESTRICTED_PARENTS.has(parent.tagName)) return false;
  return true;
}

/** 链接/导航/页脚标签一律行内；正文列表项超过 24 字符仍用块级 */
function isCompactUILabel(unit: TranslationUnit): boolean {
  const c = unit.container;
  if (c.tagName === "A" || c.closest("nav, header, footer")) return unit.text.length <= 40;
  if (c.tagName === "LI") return unit.text.length <= 24;
  return false;
}

/** 估算译文占位高度：按容器宽度与全角字符密度，保证预留空间贴近实际 */
function estimateHeight(unit: TranslationUnit): string {
  const cs = getComputedStyle(unit.container);
  const fs = parseFloat(cs.fontSize) || 14;
  const lh = parseFloat(cs.lineHeight) || fs * 1.5;
  const width = unit.container.clientWidth || Math.max(300, innerWidth - 40);
  const perLine = Math.max(10, Math.floor(width / fs));
  const lines = Math.max(1, Math.ceil(unit.text.length / perLine));
  return `${Math.min(lines * lh, 600)}px`;
}
