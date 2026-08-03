/** 译文渲染 / 模式切换 / 一键还原（译文就绪才插入，避免布局扰动） */
import type { DisplayMode } from "../shared/types";
import type { TranslationUnit } from "./extractor";

/** 父级为这些标签时译文插到容器内部（块级兄弟会破坏列表/表格结构） */
const RESTRICTED_PARENTS = new Set([
  "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "COLGROUP",
  "UL", "OL", "DL", "MENU",
]);

export class Renderer {
  private mode: DisplayMode;
  /** 容器 → 当前已插入的译文/错误块（防止重复译文） */
  private byContainer = new Map<HTMLElement, HTMLElement>();

  constructor(mode: DisplayMode) {
    this.mode = mode;
  }

  /** 预留译文空间：为块级译文插入不可见占位（估算高度），填充时不引起页面跳动 */
  reserve(unit: TranslationUnit): void {
    if (isCompactUILabel(unit) || this.byContainer.has(unit.container)) return;
    const el = document.createElement("span");
    el.className = "it-translated it-pending";
    el.setAttribute("data-it-unit", unit.id);
    el.style.minHeight = estimateHeight(unit);
    this.attach(unit.container, el);
    this.byContainer.set(unit.container, el);
  }

  /** 译文就绪：填充（复用预留占位，无预留时新建插入） */
  fill(unit: TranslationUnit, chunkResults: string[]): void {
    let el = this.byContainer.get(unit.container);
    if (!el) {
      el = document.createElement("span");
      el.className = "it-translated it-done";
      el.setAttribute("data-it-unit", unit.id);
      if (isCompactUILabel(unit)) {
        el.classList.add("it-inline");
        this.attachInline(unit.container, el);
      } else {
        this.attach(unit.container, el);
      }
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
  }

  /** 翻译失败：复用预留占位或新建，转为错误态 */
  fail(unit: TranslationUnit): void {
    let el = this.byContainer.get(unit.container);
    if (!el) {
      el = document.createElement("span");
      el.className = "it-translated it-error";
      el.setAttribute("data-it-unit", unit.id);
      this.attach(unit.container, el);
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

  /** 重试前：移除旧错误块，回到未译状态 */
  retryState(unit: TranslationUnit): void {
    this.clearContainer(unit.container);
  }

  getMode(): DisplayMode {
    return this.mode;
  }

  /** 切换显示模式：靠 body 上的类统一控制 */
  setMode(mode: DisplayMode): void {
    this.mode = mode;
    document.body.classList.toggle("it-mode-translated", mode === "translated");
    document.body.classList.toggle("it-mode-original", mode === "original");
  }

  /** 一键还原 */
  restore(): void {
    document.querySelectorAll("[data-it-unit]").forEach((n) => n.remove());
    document.querySelectorAll("[data-it-src]").forEach((n) => n.removeAttribute("data-it-src"));
    document.querySelectorAll("[data-it-processing]").forEach((n) =>
      n.removeAttribute("data-it-processing")
    );
    document.querySelectorAll("[data-it-inside]").forEach((n) => n.removeAttribute("data-it-inside"));
    document.body.classList.remove("it-mode-translated", "it-mode-original");
    this.byContainer.clear();
  }

  private attach(container: HTMLElement, el: HTMLElement): void {
    container.setAttribute("data-it-src", "");
    insertTranslation(container, el);
    this.byContainer.set(container, el);
  }

  /** 行内译文：链接插到后面；li/其他文本块插到内部，与原文并排 */
  private attachInline(container: HTMLElement, el: HTMLElement): void {
    container.setAttribute("data-it-src", "");
    if (container.tagName === "A") {
      container.after(el); // 链接：不插进链接内（会被链接样式污染），插到链接后面
    } else {
      container.setAttribute("data-it-inside", "");
      container.appendChild(el); // li 等：插到内部，flex 时作为 flex 项与原文并排
    }
    this.byContainer.set(container, el);
  }

  private clearContainer(container: HTMLElement): void {
    const prev = this.byContainer.get(container);
    if (prev) {
      prev.remove();
      this.byContainer.delete(container);
    }
    container.removeAttribute("data-it-src");
  }
}

/**
 * 插入译文：容器是链接或 flex/grid 包装器 → 插到容器后面（append 会变成新的 flex item
 * 或进链接内部）；普通块级流父级 → 插到容器后面；列表/表格/flex 父级 → 插到容器内部。
 */
function insertTranslation(container: HTMLElement, el: HTMLElement): void {
  if (container.tagName === "A" || isConstrainedLayout(container)) {
    container.after(el);
    return;
  }
  const parent = container.parentElement;
  if (parent && (RESTRICTED_PARENTS.has(parent.tagName) || isConstrainedLayout(parent))) {
    container.setAttribute("data-it-inside", "");
    container.appendChild(el);
  } else {
    container.after(el);
  }
}

function isConstrainedLayout(el: HTMLElement): boolean {
  const d = getComputedStyle(el).display;
  return (
    d.startsWith("flex") ||
    d.startsWith("grid") ||
    d.startsWith("inline") ||
    d.startsWith("table") ||
    d === "contents"
  );
}

/** 导航/页脚等紧凑 UI、独立链接或短列表项的短标签：译文用行内，避免块级译文撑高布局 */
function isCompactUILabel(unit: TranslationUnit): boolean {
  if (unit.text.length > 24) return false;
  return (
    unit.container.tagName === "A" ||
    unit.container.tagName === "LI" ||
    !!unit.container.closest("nav, header, footer")
  );
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
