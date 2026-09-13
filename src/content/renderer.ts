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

/** 预读的容器样式信息（避免 reserve/insert 循环里反复触发 getComputedStyle 重排） */
export interface ContainerStyle {
  width: number;
  fontSize: string;
  fontWeight: string;
  fontStyle: string;
  fontFamily: string;
  display: string;
  marginBottom: string;
}

/** 批量预读一组单元容器的样式信息。
 *  在写 DOM 之前一次性读取，只触发一次重排；后续 reserve/insert 直接用预读值。 */
export function precomputeStyles(units: TranslationUnit[]): Map<HTMLElement, ContainerStyle> {
  const map = new Map<HTMLElement, ContainerStyle>();
  for (const u of units) {
    if (u.textOnly) continue; // 控件原位替换，无需样式
    const c = u.container;
    if (!c.isConnected) continue;
    const cs = getComputedStyle(c);
    map.set(c, {
      width: c.clientWidth,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      fontFamily: cs.fontFamily,
      display: cs.display,
      marginBottom: cs.marginBottom,
    });
  }
  return map;
}

export class Renderer {
  private mode: DisplayMode;
  /** 容器 → 当前译文/占位元素（包裹内或行内） */
  private byContainer = new Map<HTMLElement, HTMLElement>();
  /** 容器 → 控件原文/译文（data-it-ctl-orig/trans 的镜像，供模式切换快速遍历） */
  private controlContainers = new Set<HTMLElement>();

  constructor(mode: DisplayMode) {
    this.mode = mode;
  }

  /** 预留译文空间：插入不可见占位（估算高度），填充时不引起页面跳动。
   *  style：调用方在写 DOM 前预读的样式信息，避免循环里读 getComputedStyle 触发整页重排。 */
  reserve(unit: TranslationUnit, style?: ContainerStyle): void {
    if (!unit.container.isConnected) return; // 容器已被页面移除，丢弃
    if (unit.textOnly) return; // 控件原位替换文字，无需占位
    if (this.byContainer.has(unit.container)) return;
    const el = document.createElement("span");
    el.className = "it-translated it-pending";
    el.setAttribute("data-it-unit", unit.id);
    el.style.minHeight = estimateHeight(unit, style);
    this.matchSourceFont(el, style);
    this.insert(unit, el, style);
    this.byContainer.set(unit.container, el);
    this.applyToContainer(unit.container);
  }

  /** 译文就绪：填充（复用占位，无占位或占位失效时新建插入） */
  fill(unit: TranslationUnit, chunkResults: string[]): void {
    if (!unit.container.isConnected) return; // 回填校验：容器被页面改动/移除则丢弃
    // 控件（按钮/下拉选项）：仅文本原位替换，不插入元素、不改结构，交互不受影响
    if (unit.textOnly) {
      this.fillTextOnly(unit, chunkResults);
      return;
    }
    let el = this.byContainer.get(unit.container);
    if (!el || !el.isConnected) {
      this.byContainer.delete(unit.container);
      el = document.createElement("span");
      el.className = "it-translated it-done";
      el.setAttribute("data-it-unit", unit.id);
      this.matchSourceFont(el, unit.container);
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
    if (unit.textOnly) return; // 控件翻译失败保留原文，不注入错误占位
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

  /** 控件（按钮/下拉选项）填充：仅替换文本节点，不插元素不改结构（保住图标与点击交互）。
   *  三种显示模式下都展示译文（结构上无法同时容纳双语）；原文存 data-it-ctl-orig，
   *  译文存 data-it-ctl-trans，供模式切换与还原使用。 */
  private fillTextOnly(unit: TranslationUnit, chunkResults: string[]): void {
    const c = unit.container;
    const trans = chunkResults.map((s) => s.trim()).filter(Boolean).join(" ");
    if (!trans) return; // 空译文保留原文
    if (!c.hasAttribute("data-it-ctl-orig")) {
      c.setAttribute("data-it-ctl-orig", JSON.stringify(captureTextNodes(c)));
    }
    c.setAttribute("data-it-ctl-trans", trans);
    applyTextNodes(c, trans);
    c.setAttribute("data-it-src", "");
    this.controlContainers.add(c);
  }

  /** 译文元素字体对齐原文：包裹层里译文与原文是兄弟，CSS 继承只到包裹层父级，
   *  标题/小字等字号字重会丢失，译文尺寸与原网页不一致。
   *  style：预读样式，避免每次调用都触发 getComputedStyle。 */
  private matchSourceFont(el: HTMLElement, source: HTMLElement | ContainerStyle | undefined): void {
    if (!source) return;
    let fs: string, fw: string, fst: string, ff: string;
    if (typeof source === "object" && "fontSize" in source) {
      fs = source.fontSize;
      fw = source.fontWeight;
      fst = source.fontStyle;
      ff = source.fontFamily;
    } else {
      const cs = getComputedStyle(source as HTMLElement);
      fs = cs.fontSize;
      fw = cs.fontWeight;
      fst = cs.fontStyle;
      ff = cs.fontFamily;
    }
    if (fs) el.style.fontSize = fs;
    if (fw) el.style.fontWeight = fw;
    if (fst) el.style.fontStyle = fst;
    if (ff) el.style.fontFamily = ff;
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
    this.applyTextOnlyMode();
    if (mode === "translated") {
      this.applyTranslatedMode();
    } else {
      this.clearTranslatedMode();
    }
    document.body.classList.toggle("it-mode-translated", mode === "translated");
    document.body.classList.toggle("it-mode-original", mode === "original");
    // 包裹层 display 随模式更新（避免仅译文布局跳动）——用 byContainer 迭代代替 querySelectorAll
    for (const container of this.byContainer.keys()) {
      const transEl = this.byContainer.get(container);
      const wrap = transEl?.closest?.(".it-wrap") as HTMLElement | null;
      if (wrap) this.applyWrapDisplay(wrap);
    }
  }

  /** 控件（按钮/选项）文字随模式切换：双语/仅译文显示译文，原文模式恢复原文 */
  private applyTextOnlyMode(): void {
    for (const c of this.controlContainers) {
      if (!c.isConnected) continue;
      if (this.mode === "original") {
        const raw = c.getAttribute("data-it-ctl-orig");
        if (raw) restoreTextNodes(c, raw);
      } else {
        const trans = c.getAttribute("data-it-ctl-trans");
        if (trans) applyTextNodes(c, trans);
      }
    }
  }

  /** 仅译文：把每个译文块的原文文字原位替换为译文，保留结构（链接可点击、样式不变） */
  private applyTranslatedMode(): void {
    for (const [container, transEl] of this.byContainer) {
      if (!container.isConnected || !transEl.isConnected) continue;
      // 失败占位（双语下产生的）切到仅译文时隐藏：原文未被替换，红字错误块不该混在译文里
      if (transEl.classList.contains("it-error")) {
        transEl.classList.add("it-translated-hidden");
        continue;
      }
      this.applyToContainer(container);
    }
  }

  private applyToContainer(container: HTMLElement): void {
    if (this.mode !== "translated" || !container.isConnected) return;
    const transEl = this.byContainer.get(container);
    if (!transEl || !transEl.isConnected) return;
    // 失败/错误态不替换原文（不应把"翻译失败"文字写进段落）
    if (transEl.classList.contains("it-error")) return;
    const trans = (transEl.textContent ?? "").trim();
    if (!trans) return;

    // 包裹容器（.it-orig 在 .it-wrap 内）：纯 CSS 切换，零 DOM 修改
    if (container.parentElement?.classList.contains("it-wrap")) {
      if (!container.hasAttribute("data-it-inplace")) {
        container.setAttribute("data-it-orig-hidden", "");
        transEl.classList.remove("it-translated-hidden");
        container.setAttribute("data-it-inplace", "");
      }
      return;
    }

    // 内部插入 / 行内容器：文本节点原位替换
    const target = getSourceTarget(container);
    if (!target.hasAttribute("data-it-orig-text")) {
      target.setAttribute("data-it-orig-text", JSON.stringify(captureTextNodes(target)));
    }
    if (!target.hasAttribute("data-it-inplace")) {
      applyTextNodes(target, trans);
      target.setAttribute("data-it-inplace", "");
    }
    transEl.classList.add("it-translated-hidden");
  }

  /** 离开仅译文：还原原文文字（仅恢复文本节点，不重建 DOM 元素），显示译文元素 */
  private clearTranslatedMode(): void {
    // 用 byContainer 迭代代替多次 querySelectorAll 全文档扫描。
    // byContainer 覆盖了所有已翻译容器；少数遗留属性（旧版 data-it-orig-html）兜底全局扫一次。
    for (const [container, transEl] of this.byContainer) {
      if (!container.isConnected) continue;
      // 包裹容器：恢复原文可见，隐藏译文
      if (container.hasAttribute("data-it-orig-hidden")) {
        container.removeAttribute("data-it-orig-hidden");
        container.removeAttribute("data-it-inplace");
      }
      // 包裹容器内已显示的译文重新隐藏
      if (
        transEl.isConnected &&
        transEl.parentElement?.classList.contains("it-wrap") &&
        !transEl.classList.contains("it-translated-hidden")
      ) {
        transEl.classList.add("it-translated-hidden");
      }
      // 内部插入 / 行内容器：恢复文本节点
      if (container.hasAttribute("data-it-inplace") && !container.parentElement?.classList.contains("it-wrap")) {
        const target = getSourceTarget(container);
        const raw = target.getAttribute("data-it-orig-text");
        if (raw) restoreTextNodes(target, raw);
        target.removeAttribute("data-it-orig-text");
        target.removeAttribute("data-it-orig-html");
        target.removeAttribute("data-it-inplace");
      }
      // 显示译文元素（离开仅译文）
      if (transEl.isConnected && transEl.classList.contains("it-translated-hidden")) {
        transEl.classList.remove("it-translated-hidden");
      }
    }
    // 兼容旧版：仍在用 data-it-orig-html 的元素（升级前已进入仅译文模式的页面）
    document.querySelectorAll("[data-it-orig-html]").forEach((el) => {
      el.innerHTML = el.getAttribute("data-it-orig-html") ?? "";
      el.removeAttribute("data-it-orig-html");
      el.removeAttribute("data-it-inplace");
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
    // 控件（按钮/选项）：恢复原文文字（结构始终未动）——用 controlContainers 代替 querySelectorAll
    for (const c of this.controlContainers) {
      if (!c.isConnected) continue;
      const raw = c.getAttribute("data-it-ctl-orig");
      if (raw) restoreTextNodes(c, raw);
      c.removeAttribute("data-it-ctl-orig");
      c.removeAttribute("data-it-ctl-trans");
      c.removeAttribute("data-it-src"); // 控件也标记了 data-it-src，需一并清除
    }
    // 解包：原文移回原位，译文随包裹层一起移除——用 byContainer 找包裹层代替 querySelectorAll
    for (const [container, transEl] of this.byContainer) {
      if (!container.isConnected) continue;
      const wrap = transEl.closest?.(".it-wrap");
      if (wrap) {
        const orig = wrap.querySelector(":scope > .it-orig");
        if (orig) wrap.before(orig);
        wrap.remove();
      } else if (transEl.isConnected) {
        transEl.remove();
      }
      // 清理仅译文模式标记
      container.removeAttribute("data-it-src");
      container.removeAttribute("data-it-orig-hidden");
      container.removeAttribute("data-it-inplace");
      container.classList.remove("it-orig");
    }
    document.body.classList.remove("it-mode-translated", "it-mode-original");
    this.byContainer.clear();
    this.controlContainers.clear();
  }

  /** 插入译文/占位：
   * 紧凑标签 → 行内；容器本身是 flex/grid → 包裹（译文放下面，避免译文变 flex 项横排错位）；
   * 块容器 + 块级流父级 → 包裹；块容器 + flex/grid/列表/表格父级 → 插内部（保持原布局项） */
  private insert(unit: TranslationUnit, el: HTMLElement, style?: ContainerStyle): void {
    const container = unit.container;
    container.setAttribute("data-it-src", "");
    const parent = container.parentElement;
    const containerDisplay = style?.display ?? getComputedStyle(container).display;
    const containerConstrained = isConstrainedDisplay(containerDisplay);
    const parentConstrained = !!parent && isConstrainedLayout(parent);
    if (isCompactUILabel(unit)) {
      this.attachInline(container, el);
    } else if (canWrap(container) && (containerConstrained || !parentConstrained)) {
      this.wrapContainer(container, el, style);
    } else {
      container.setAttribute("data-it-inside", "");
      container.appendChild(el);
    }
  }

  /** 包裹：把原文容器移进 .it-wrap（顶替原位置），译文作为兄弟 */
  private wrapContainer(container: HTMLElement, el: HTMLElement, style?: ContainerStyle): void {
    // 测量原文段落的真实底边距，应用到译文底部 → 段落间距与原文一致，位置精确
    //（必须在容器移入包裹前测量，否则 .it-wrap>.it-orig 的 margin-bottom:0 会覆盖）
    const mb = style?.marginBottom ?? getComputedStyle(container).marginBottom;
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

  /** 行内译文：summary 插到后面（保持 details>summary 结构）；
   *  链接与其他文本块插到内部末尾——插成兄弟会在 flex/grid 导航里新增布局项，
   *  把原有组件挤走，且在 ul/ol 里产生非法结构 */
  private attachInline(container: HTMLElement, el: HTMLElement): void {
    if (container.tagName === "SUMMARY") {
      container.after(el);
    } else {
      container.setAttribute("data-it-inside", "");
      container.appendChild(el);
    }
  }

  private clearContainer(container: HTMLElement): void {
    // 控件（按钮/选项）：恢复原文后由重试重新填充
    if (container.hasAttribute("data-it-ctl-orig")) {
      const raw = container.getAttribute("data-it-ctl-orig");
      if (raw) restoreTextNodes(container, raw);
      container.removeAttribute("data-it-ctl-orig");
      container.removeAttribute("data-it-ctl-trans");
      container.removeAttribute("data-it-src");
      return;
    }
    const prev = this.byContainer.get(container);
    const wasWrapped = container.hasAttribute("data-it-orig-hidden");
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
    // 清理仅译文模式标记
    container.removeAttribute("data-it-orig-hidden");
    container.removeAttribute("data-it-inplace");

    // 包裹容器：译文的 data-it-unit 已随 .it-wrap 移除，无需额外清理
    if (wasWrapped) {
      container.removeAttribute("data-it-src");
      return;
    }

    // 内部插入 / 行内容器：还原原文文本
    const target = getSourceTarget(container);
    const raw = target.getAttribute("data-it-orig-text");
    if (raw) {
      restoreTextNodes(target, raw);
      target.removeAttribute("data-it-orig-text");
    }
    // 兼容旧版 data-it-orig-html
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
  return isConstrainedDisplay(d);
}

/** 判断 display 字符串是否为受限布局（避免重复 getComputedStyle） */
function isConstrainedDisplay(d: string): boolean {
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

/** 估算译文占位高度：按容器宽度与全角字符密度，保证预留空间贴近实际。
 *  style：调用方在写 DOM 前预读的样式；缺省时才回退读 getComputedStyle（会触发重排）。 */
function estimateHeight(unit: TranslationUnit, style?: ContainerStyle): string {
  let fs: number;
  let lh: number;
  let width: number;
  if (style) {
    fs = parseFloat(style.fontSize) || 14;
    lh = parseFloat(style.fontSize) * 1.5; // lineHeight 不在预读里，用 fontSize*1.5 估算
    width = style.width || Math.max(300, innerWidth - 40);
  } else {
    const cs = getComputedStyle(unit.container);
    fs = parseFloat(cs.fontSize) || 14;
    lh = parseFloat(cs.lineHeight) || fs * 1.5;
    width = unit.container.clientWidth || Math.max(300, innerWidth - 40);
  }
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

// ---- 仅译文模式：非破坏性文本替换（保留链接/图标/表单控件与事件监听器） ----
// 关键设计：替换范围是「文本节点」，但绝不穿透保护元素（链接/按钮/SVG/代码等）子树。
// 旧实现只替换直接子级文本节点：嵌套 <span>/<b> 等内的原文会原样残留，
// 导致仅译文模式下译文与原文同屏混杂；现在统一按 collectTextNodes 深度收集后替换。

/** 保护元素：文本替换不穿透这些子树（保住链接可点击、图标、表单控件、代码展示） */
const PROTECTED_TAGS = new Set([
  "A", "BUTTON", "SELECT", "OPTION", "TEXTAREA", "INPUT",
  "SVG", "MATH", "CODE", "PRE", "KBD", "SAMP", "VAR",
  "SCRIPT", "STYLE", "IFRAME", "CANVAS", "IMG", "VIDEO", "AUDIO",
]);

function isProtected(el: HTMLElement): boolean {
  return (
    PROTECTED_TAGS.has(el.tagName) ||
    el.isContentEditable ||
    el.getAttribute("translate") === "no" ||
    el.hasAttribute("data-it-unit") || // 我们自己的译文/占位元素
    el.hasAttribute("data-it-ui")
  );
}

/** 收集元素下的文本节点（含嵌套层级，跳过保护子树与我们的 UI）。
 *  捕获 / 替换 / 还原必须走同一套收集逻辑，保证节点顺序一一对应。 */
function collectTextNodes(el: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (let p = node.parentElement; p && p !== el; p = p.parentElement) {
        if (isProtected(p)) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);
  return nodes;
}

/** 捕获元素下文本节点内容，返回 JSON 字符串数组 */
function captureTextNodes(el: HTMLElement): string[] {
  return collectTextNodes(el).map((n) => n.textContent ?? "");
}

/** 用译文替换目标元素内的文本节点：第一个非空节点承载全部译文，其余清空。
 *  元素子节点本身不动；保护子树（链接/图标/控件）内的文字原样保留。 */
function applyTextNodes(target: HTMLElement, translation: string): void {
  const nodes = collectTextNodes(target);
  if (nodes.length === 0) {
    target.insertBefore(document.createTextNode(translation), target.firstChild);
    return;
  }
  const hostIdx = nodes.findIndex((n) => (n.textContent ?? "").trim() !== "");
  const host = hostIdx >= 0 ? hostIdx : 0;
  nodes.forEach((n, i) => {
    n.textContent = i === host ? translation : "";
  });
}

/** 从保存的 JSON 数组还原文本节点内容（与 captureTextNodes 配对） */
function restoreTextNodes(el: HTMLElement, raw: string): void {
  let texts: string[];
  try {
    texts = JSON.parse(raw) as string[];
  } catch {
    return;
  }
  if (!Array.isArray(texts)) return;
  const nodes = collectTextNodes(el);
  let i = 0;
  for (; i < texts.length && i < nodes.length; i++) {
    nodes[i].textContent = texts[i];
  }
  // 保存的文本比当前文本节点多 → 在末尾补回
  while (i < texts.length) {
    el.appendChild(document.createTextNode(texts[i]));
    i++;
  }
}
