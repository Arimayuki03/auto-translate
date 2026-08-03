/** 译文渲染 / 模式切换 / 一键还原（阶段 3） */
import type { DisplayMode } from "../shared/types";
import type { TranslationUnit } from "./extractor";

/** 插入译文块会破坏表格结构的父容器 → 这些情况改为插到容器内部末尾 */
const RESTRICTED_PARENTS = new Set(["TABLE", "THEAD", "TBODY", "TFOOT", "TR", "COLGROUP"]);

export class Renderer {
  private mode: DisplayMode;
  private placeholders = new Map<string, HTMLElement>();

  constructor(mode: DisplayMode) {
    this.mode = mode;
  }

  /** 在单元容器后插入占位（已存在则复用） */
  createPlaceholder(unit: TranslationUnit): HTMLElement {
    const existing = this.placeholders.get(unit.id);
    if (existing) return existing;

    const el = document.createElement("div");
    el.className = "it-translated it-loading";
    el.setAttribute("data-it-unit", unit.id);
    el.style.minHeight = `${estimateHeight(unit.text)}px`;

    const dots = document.createElement("span");
    dots.className = "it-dots";
    el.appendChild(dots);

    unit.container.setAttribute("data-it-src", "");
    insertAfterContainer(unit.container, el);
    this.placeholders.set(unit.id, el);
    return el;
  }

  /** 译文就绪：按 chunk 顺序写入 */
  fill(unit: TranslationUnit, chunkResults: string[]): void {
    const el = this.placeholders.get(unit.id);
    if (!el || !el.isConnected) return; // 容器被页面改动移除则丢弃
    el.textContent = "";
    el.classList.remove("it-loading", "it-error");
    el.classList.add("it-done");
    for (const chunk of chunkResults) {
      const p = document.createElement("p");
      p.className = "it-chunk";
      p.textContent = chunk.trim();
      el.appendChild(p);
    }
  }

  /** 翻译失败：占位转错误态，附重试按钮 */
  fail(unit: TranslationUnit): void {
    const el = this.placeholders.get(unit.id);
    if (!el || !el.isConnected) return;
    el.textContent = "";
    el.classList.remove("it-loading");
    el.classList.add("it-error");
    const span = document.createElement("span");
    span.className = "it-err-text";
    span.textContent = "翻译失败";
    const retry = document.createElement("button");
    retry.className = "it-retry";
    retry.textContent = "重试";
    retry.setAttribute("data-it-unit", unit.id);
    el.append(span, retry);
  }

  /** 重试前恢复 loading 态（复用原占位） */
  retryState(unit: TranslationUnit): void {
    const el = this.placeholders.get(unit.id);
    if (!el || !el.isConnected) return;
    el.textContent = "";
    el.classList.remove("it-error");
    el.classList.add("it-loading");
    const dots = document.createElement("span");
    dots.className = "it-dots";
    el.appendChild(dots);
  }

  getMode(): DisplayMode {
    return this.mode;
  }

  /** 切换显示模式：靠 body 上的类统一控制（见 content.css） */
  setMode(mode: DisplayMode): void {
    this.mode = mode;
    document.body.classList.toggle("it-mode-translated", mode === "translated");
    document.body.classList.toggle("it-mode-original", mode === "original");
  }

  /** 一键还原：移除全部译文节点与源标记 */
  restore(): void {
    document.querySelectorAll("[data-it-unit]").forEach((n) => n.remove());
    document.querySelectorAll("[data-it-src]").forEach((n) => n.removeAttribute("data-it-src"));
    document.body.classList.remove("it-mode-translated", "it-mode-original");
    this.placeholders.clear();
  }
}

function insertAfterContainer(container: HTMLElement, el: HTMLElement): void {
  const parent = container.parentElement;
  if (parent && RESTRICTED_PARENTS.has(parent.tagName)) {
    // 表格类容器：块级兄弟节点会破坏表格布局，插到单元格内部末尾
    container.setAttribute("data-it-inside", "");
    container.appendChild(el);
  } else {
    container.after(el);
  }
}

/** 按字符数粗略估算占位高度，减少插入时的滚动跳动 */
function estimateHeight(text: string): number {
  const lines = Math.max(1, Math.ceil(text.length / 40));
  return Math.min(lines * 30, 200);
}
