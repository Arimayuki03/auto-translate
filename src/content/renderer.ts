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
    this.applyToContainer(unit.container);
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
    this.applyToContainer(unit.container);
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
    // 仅译文模式：原文未被替换（翻译失败不应覆盖原文），需要隐藏错误元素
    if (this.mode === "translated") {
      el.classList.add("it-translated-hidden");
    }
  }

  /** 重试前：移除旧内容（解包原文），回到未译状态 */
  retryState(unit: TranslationUnit): void {
    this.clearContainer(unit.container);
  }

  /** 该容器的译文是否为失败态（供重试筛选） */
  isFailed(container: HTMLElement): boolean {
    const el = this.byContainer.get(container);
    return !!el && el.classList.contains("it-error");
  }

  getMode(): DisplayMode {
    return this.mode;
  }

  /** 切换显示模式：仅译文用"原位替换原文文字"（保留元素结构与链接），双语/原文恢复 */
  setMode(mode: DisplayMode): void {
    this.mode = mode;
    if (mode === "translated") {
      this.applyTranslatedMode();
    } else {
      this.clearTranslatedMode();
    }
    document.body.classList.toggle("it-mode-translated", mode === "translated");
    document.body.classList.toggle("it-mode-original", mode === "original");
    // 包裹层 display 随模式更新（避免仅译文布局跳动）
    document.querySelectorAll(".it-wrap").forEach((w) => this.applyWrapDisplay(w as HTMLElement));
  }

  /** 仅译文：把每个译文块的原文文字原位替换为译文，保留结构（链接可点击、样式不变） */
  private applyTranslatedMode(): void {
    for (const container of this.byContainer.keys()) this.applyToContainer(container);
  }

  private applyToContainer(container: HTMLElement): void {
    if (this.mode !== "translated" || !container.isConnected) return;
    const transEl = this.byContainer.get(container);
    if (!transEl || !transEl.isConnected) return;
    // 失败/错误态不替换原文（不应把"翻译失败"文字写进段落）
    if (transEl.classList.contains("it-error")) return;
    const trans = (transEl.textContent ?? "").trim();
    if (!trans) return;
    const target = getSourceTarget(container);
    if (!target.hasAttribute("data-it-orig-html")) {
      target.setAttribute("data-it-orig-html", target.innerHTML);
    }
    // 只原位替换一次，避免重复调用导致重复/错乱
    if (!target.hasAttribute("data-it-inplace")) {
      if (target === container) {
        // 普通容器：替换文字；保留无文本子元素（图片/br 等），去掉有文本的内联元素
        //（链接/加粗等，其文字已并入整段译文，避免"译文+原文残留"）
        const keep = Array.from(target.children).filter((c) => !(c.textContent ?? "").trim());
        target.textContent = trans;
        for (const c of keep) target.appendChild(c);
      } else {
        // 链接（或只包一个链接的容器）：替换链接文字，保留可点击
        target.textContent = trans;
      }
      target.setAttribute("data-it-inplace", "");
    }
    transEl.classList.add("it-translated-hidden");
  }

  /** 离开仅译文：还原原文文字，显示译文元素 */
  private clearTranslatedMode(): void {
    document.querySelectorAll("[data-it-orig-html]").forEach((el) => {
      el.innerHTML = el.getAttribute("data-it-orig-html") ?? "";
      el.removeAttribute("data-it-orig-html");
      el.removeAttribute("data-it-inplace");
    });
    document.querySelectorAll(".it-translated-hidden").forEach((el) => {
      el.classList.remove("it-translated-hidden");
    });
    // 修复非包裹容器的 byContainer 引用：innerHTML 恢复后译文元素是新建节点，
    // 旧引用已脱离 DOM，不更新会导致下次切换到仅译文时 in-place 替换失效
    for (const [container, transEl] of this.byContainer) {
      if (!transEl.isConnected) {
        const unitId = transEl.getAttribute("data-it-unit");
        const newEl = unitId
          ? (container.querySelector<HTMLElement>(`[data-it-unit="${unitId}"]`))
          : null;
        if (newEl) {
          this.byContainer.set(container, newEl);
        } else {
          this.byContainer.delete(container);
        }
      }
    }
  }

  /** 一键还原：解包把原文移回原位，移除全部译文与标记 */
  restore(): void {
    this.clearTranslatedMode();
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

  /** 插入译文/占位：
   * 紧凑标签 → 行内；容器本身是 flex/grid → 包裹（译文放下面，避免译文变 flex 项横排错位）；
   * 块容器 + 块级流父级 → 包裹；块容器 + flex/grid/列表/表格父级 → 插内部（保持原布局项） */
  private insert(unit: TranslationUnit, el: HTMLElement): void {
    const container = unit.container;
    container.setAttribute("data-it-src", "");
    const parent = container.parentElement;
    const containerConstrained = isConstrainedLayout(container);
    const parentConstrained = !!parent && isConstrainedLayout(parent);
    if (isCompactUILabel(unit)) {
      this.attachInline(container, el);
    } else if (canWrap(container) && (containerConstrained || !parentConstrained)) {
      this.wrapContainer(container, el);
    } else {
      container.setAttribute("data-it-inside", "");
      container.appendChild(el);
    }
  }

  /** 包裹：把原文容器移进 .it-wrap（顶替原位置），译文作为兄弟 */
  private wrapContainer(container: HTMLElement, el: HTMLElement): void {
    // 测量原文段落的真实底边距，应用到译文底部 → 段落间距与原文一致，位置精确
    //（必须在容器移入包裹前测量，否则 .it-wrap>.it-orig 的 margin-bottom:0 会覆盖）
    const mb = getComputedStyle(container).marginBottom;
    if (mb && mb !== "0px") el.style.marginBottom = mb;
    const wrap = document.createElement("div");
    wrap.className = "it-wrap";
    wrap.setAttribute("data-it-unit", el.getAttribute("data-it-unit") ?? "");
    container.before(wrap);
    wrap.appendChild(container);
    wrap.appendChild(el);
    container.classList.add("it-orig");
    this.applyWrapDisplay(wrap);
  }

  /** 包裹层 display：仅译文或块级流父级用 contents（不产生盒子、布局零变化，避免页面跳动）；
   *  双语 + flex/grid 父级用 block（包裹层作为单一布局项，避免译文变成多余 flex 项） */
  private applyWrapDisplay(wrap: HTMLElement): void {
    const parent = wrap.parentElement;
    const box = this.mode !== "translated" && !!parent && isConstrainedLayout(parent);
    wrap.style.display = box ? "block" : "contents";
  }

  /** 行内译文：链接/折叠摘要插到后面（保持 details>summary 结构不被破坏）；li/其他文本块插到内部 */
  private attachInline(container: HTMLElement, el: HTMLElement): void {
    if (container.tagName === "A" || container.tagName === "SUMMARY") {
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
    // 清理仅译文模式的 in-place 替换状态（target 可能 ≠ container，如 <li><a> 的链接元素）、
    // 还原原文文字，否则下次翻译的 in-place 替换会被 data-it-inplace 守卫跳过
    const target = getSourceTarget(container);
    if (target.hasAttribute("data-it-orig-html")) {
      target.innerHTML = target.getAttribute("data-it-orig-html") ?? "";
      target.removeAttribute("data-it-orig-html");
    }
    target.removeAttribute("data-it-inplace");
    container.removeAttribute("data-it-src");
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

/** 父级是否为 flex/grid/表格等特殊布局（决定包裹层用 block 还是 contents） */
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

/** 链接/折叠摘要/导航/页脚标签一律行内；正文列表项超过 24 字符仍用块级 */
function isCompactUILabel(unit: TranslationUnit): boolean {
  const c = unit.container;
  if (
    c.tagName === "A" ||
    c.tagName === "SUMMARY" ||
    c.closest("nav, header, footer")
  ) {
    return unit.text.length <= 40;
  }
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

/**
 * 仅译文原位替换目标：容器是链接或"只包一个链接"（如 <li><a>）→ 替换链接文字，保留可点击；
 * 否则替换容器文字（元素/样式不变）。
 */
function getSourceTarget(container: HTMLElement): HTMLElement {
  if (container.tagName === "A") return container;
  const hasOwnText = Array.from(container.childNodes).some(
    (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()
  );
  if (hasOwnText) return container;
  const links = Array.from(container.children).filter((c) => c.tagName === "A");
  const meaningful = Array.from(container.children).filter(
    (c) => !c.classList.contains("it-translated")
  ).length;
  if (links.length === 1 && meaningful === 1) return links[0] as HTMLElement;
  return container;
}
