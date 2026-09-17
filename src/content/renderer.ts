/** 译文渲染 / 模式切换 / 一键还原
 *  核心架构：块级译文用「包裹原块」——.it-wrap 顶替原元素在布局中的位置，
 *  译文作为兄弟放在包裹层内，不新增父级布局项，避免 flex/grid/表格被挤变形。
 *  列表/表格项（li/td）不能包，退回「插内部」；导航/页脚等紧凑标签用「行内」。
 */
import type { DisplayMode, TranslationStyle } from "../shared/types";
import type { TranslationUnit } from "./extractor";
import { usesIconFont } from "./extractor";
import { t } from "../shared/i18n";

/** 父级为这些标签时译文插到容器内部（块级兄弟会破坏列表/表格结构） */
const RESTRICTED_PARENTS = new Set([
  "TABLE",
  "THEAD",
  "TBODY",
  "TFOOT",
  "TR",
  "COLGROUP",
  "UL",
  "OL",
  "DL",
  "MENU",
]);

/** 元素自身是列表/表格项，不能包（包裹层会成为其父级的非法子元素） */
const NON_WRAPPABLE = new Set(["LI", "TD", "TH", "DD", "DT", "TR", "CAPTION"]);

/** 预读的容器样式信息（避免 reserve/insert 循环里反复触发 getComputedStyle 重排） */
export interface ContainerStyle {
  width: number;
  fontSize: string;
  /** computed line-height（可能是 "normal"，解析失败走 fallback） */
  lineHeight: string;
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
      lineHeight: cs.lineHeight,
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
  /** 目标语言：占位高度估算与 chunk 分隔符按语言调整 */
  private targetLang: string;
  /** 容器 → 当前译文/占位元素（包裹内或行内） */
  private byContainer = new Map<HTMLElement, HTMLElement>();
  /** 容器 → 单元（供仅译文渲染读取 linkParts 等结构信息；与 byContainer 同生命周期） */
  private unitByContainer = new Map<HTMLElement, TranslationUnit>();
  /** 源文本 → 已译文（跨容器共享）：行内链接单元被引擎去重跳过时，
   *  父块拆段嵌入仍能从兄弟单元的回填结果里拿到它的译文 */
  private textTranslations = new Map<string, string>();
  /** 仅译文拆段嵌入在等链接译文回填的父块：任何 fill 后重试，模式切换时也会重试 */
  private pendingSplits = new Set<HTMLElement>();
  /** 拆段失败降级（整句译文直接替换）时被隐藏的原文链接元素，按父块记录以便清理 */
  private splitHiddenLinks = new Map<HTMLElement, Set<HTMLElement>>();
  /** 容器 → 原位替换的真实目标（快照/标记所在元素）。还原必须按登记来：
   *  拆段嵌入可以把父块自有文本全部清空，getSourceTarget 的启发式此时会误判到
   *  唯一链接上，父块原文就永远还不回来了。 */
  private inplaceTargets = new Map<HTMLElement, HTMLElement>();
  /** 容器 → 控件原文/译文（data-it-ctl-orig/trans 的镜像，供模式切换快速遍历） */
  private controlContainers = new Set<HTMLElement>();
  /** 已注入译文样式的 shadow root → sheet（WeakMap 记录：随宿主回收，每 root 只注入一次） */
  private shadowSheets = new WeakMap<
    ShadowRoot,
    { sheet: CSSStyleSheet | HTMLStyleElement; mode: DisplayMode }
  >();

  constructor(mode: DisplayMode, targetLang = "zh-CN") {
    this.mode = mode;
    this.targetLang = targetLang;
  }

  /** 目标语言切换（工具条换语言时同步，后续填充按新语言渲染） */
  setTargetLang(lang: string): void {
    this.targetLang = lang;
  }

  /** 预留译文空间：插入占位（骨架屏 + 估算高度），填充时不引起页面跳动。
   *  style：调用方在写 DOM 前预读的样式信息，避免循环里读 getComputedStyle 触发整页重排。 */
  reserve(unit: TranslationUnit, style?: ContainerStyle): void {
    if (!unit.container.isConnected) return; // 容器已被页面移除，丢弃
    if (unit.textOnly) return; // 控件原位替换文字，无需占位
    if (this.byContainer.has(unit.container)) return;
    const inline = isCompactUILabel(unit);
    const el = document.createElement("span");
    el.className = "it-translated it-pending";
    if (inline) el.classList.add("it-inline"); // 行内占位与填充后的 it-inline 同构，不撑破行
    el.setAttribute("data-it-unit", unit.id);
    el.style.minHeight = estimateHeight(unit, style, this.targetLang, inline);
    this.matchSourceFont(el, style);
    this.insert(unit, el, style);
    this.byContainer.set(unit.container, el);
    this.unitByContainer.set(unit.container, unit);
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
    this.unitByContainer.set(unit.container, unit);
    el.classList.remove("it-pending", "it-error");
    el.classList.add("it-done");
    el.style.minHeight = "";
    el.textContent = "";
    if (isCompactUILabel(unit)) {
      el.classList.add("it-inline");
      el.textContent = chunkResults.map((c) => c.trim()).join(" / ");
    } else {
      // 多 chunk 流式拼接为一个自然段（与原文块的阅读形态一致）：
      // 非 CJK 目标语言在句子块之间补空格（CJK 无词间空格的习惯）
      const needsSpace = !CJK_TARGET_RE.test(this.targetLang);
      chunkResults.forEach((chunk, i) => {
        if (i > 0 && needsSpace) el.appendChild(document.createTextNode(" "));
        const s = document.createElement("span");
        s.className = "it-chunk";
        s.textContent = chunk.trim();
        el.appendChild(s);
      });
    }
    this.textTranslations.set(unit.text, (el.textContent ?? "").trim());
    this.applyToContainer(unit.container);
    this.retryPendingSplits(); // 链接译文迟到：重试等待它的父块拆段嵌入
  }

  /** 任何回填后重试挂起的父块拆段（链接单元被去重跳过/批次乱序时靠这里收敛） */
  private retryPendingSplits(): void {
    if (this.pendingSplits.size === 0) return;
    for (const c of [...this.pendingSplits]) {
      if (!c.isConnected) {
        this.pendingSplits.delete(c);
        this.clearSplitHiddenLinks(c);
        continue;
      }
      this.applyToContainer(c);
    }
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
    span.textContent = t("translateFailed");
    const retry = document.createElement("button");
    retry.className = "it-retry";
    retry.textContent = t("retry");
    retry.setAttribute("data-it-unit", unit.id);
    el.append(span, retry);
    // 仅译文模式：原文未被替换（翻译失败不应覆盖原文），需要隐藏错误元素
    if (this.mode === "translated") {
      el.classList.add("it-translated-hidden");
    }
    // 失败的链接单元：等待它的父块拆段进入"过渡态"判定
    this.retryPendingSplits();
  }

  /** 控件（按钮/下拉选项）填充：仅替换文本节点，不插元素不改结构（保住图标与点击交互）。
   *  三种显示模式下都展示译文（结构上无法同时容纳双语）；原文存 data-it-ctl-orig，
   *  译文存 data-it-ctl-trans，供模式切换与还原使用。 */
  private fillTextOnly(unit: TranslationUnit, chunkResults: string[]): void {
    const c = unit.container;
    const trans = chunkResults
      .map((s) => s.trim())
      .filter(Boolean)
      .join(" ");
    if (!trans) return; // 空译文保留原文
    if (!c.hasAttribute("data-it-ctl-orig")) {
      c.setAttribute("data-it-ctl-orig", JSON.stringify(captureTextNodes(c)));
    }
    c.setAttribute("data-it-ctl-trans", trans);
    applyTextNodes(c, trans);
    c.setAttribute("data-it-src", "");
    this.controlContainers.add(c);
    // 控件译文可能正被某个挂起的父块拆段借用（同文本链接被去重跳过的场景）
    this.textTranslations.set(unit.text, trans);
    this.retryPendingSplits();
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
    for (const [container, transEl] of this.byContainer) {
      // 脱离文档的容器/译文及时清掉：无限滚动、虚拟列表等长会话页面下 Map 不再无界增长
      if (!container.isConnected || !transEl.isConnected) {
        // 丢索引前先把标记与包裹层解干净：回收节点之后可能再挂回，只删索引会留下永久孤儿译文块
        this.discardContainer(container, transEl);
        this.byContainer.delete(container);
        this.unitByContainer.delete(container);
        this.pendingSplits.delete(container);
        this.inplaceTargets.delete(container);
        this.clearSplitHiddenLinks(container);
        continue;
      }
      const wrap = transEl.closest?.(".it-wrap") as HTMLElement | null;
      if (wrap) this.applyWrapDisplay(wrap);
    }
    this.syncShadowStyles(); // body 模式类不跨 shadow 边界，shadow 内样式文本需按新模式重建
  }

  /** 控件（按钮/选项）文字随模式切换：双语/仅译文显示译文，原文模式恢复原文 */
  private applyTextOnlyMode(): void {
    for (const c of this.controlContainers) {
      if (!c.isConnected) {
        // 失连即清（防泄漏），但清之前先把控件文字与标记还原：回收节点再挂回时不能带着译文/标记
        const raw = c.getAttribute("data-it-ctl-orig");
        if (raw) restoreTextNodes(c, raw);
        c.removeAttribute("data-it-ctl-orig");
        c.removeAttribute("data-it-ctl-trans");
        c.removeAttribute("data-it-src");
        this.controlContainers.delete(c);
        continue;
      }
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
      if (!container.isConnected || !transEl.isConnected) {
        this.discardContainer(container, transEl); // 丢索引前解干净标记，回收节点再挂回不留孤儿
        this.byContainer.delete(container);
        this.unitByContainer.delete(container);
        this.pendingSplits.delete(container);
        this.inplaceTargets.delete(container);
        continue;
      }
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

    const target = getSourceTarget(container);
    const nodes = collectTextNodes(target);
    // 包裹容器且目标内已无可替换的文本节点（原文全在保护子树里，如链接+按钮的卡片）：
    // 退回纯 CSS 切换——藏原文块、显示译文元素，避免译文插进保护子树旁造成重复
    if (!nodes.length && container.parentElement?.classList.contains("it-wrap")) {
      if (!container.hasAttribute("data-it-inplace")) {
        container.setAttribute("data-it-orig-hidden", "");
        transEl.classList.remove("it-translated-hidden");
        container.setAttribute("data-it-inplace", "");
      }
      return;
    }
    // 非包裹容器无可替换文本节点：译文元素自身已在容器内（行内/内部插入形态），
    // 原文文字都在保护子树里。绝不往 target 里插入新译文文本节点——快照为空时
    // 还原流程删不掉插入的节点，会残留一段删不掉的译文垃圾（还原后仍显示在页面上）
    if (!nodes.length) return;

    // 含行内链接的块：整句译文（源句含链接文字，送 API 完整）按链接译文拆段嵌入缝隙，
    // 链接文字由各自的 <a> 单元原位替换——不破碎、不重复、保持可点击
    if (target === container && this.unitByContainer.get(container)?.linkParts?.length) {
      this.applyLinkSplit(container, target, nodes, trans, transEl);
      return;
    }

    // 文本节点原位替换（包裹/内部/行内统一）：
    // 链接（或只包一个链接的容器）替换链接文字，保持可点击跳转；普通容器替换自身文字
    //（结构、图片、保护子树不动）。旧版对包裹容器只做 CSS 隐藏原文块，会把块内 <a>
    // 一起藏掉，仅译文模式下标题链接/长链接/卡片链接全部无法点击跳转。
    if (!target.hasAttribute("data-it-orig-text")) {
      target.setAttribute(
        "data-it-orig-text",
        JSON.stringify(nodes.map((n) => n.textContent ?? ""))
      );
    }
    if (!target.hasAttribute("data-it-inplace")) {
      applyTextNodes(target, trans, nodes);
      target.setAttribute("data-it-inplace", "");
      this.inplaceTargets.set(container, target);
    }
    transEl.classList.add("it-translated-hidden");
  }

  /** 仅译文：把父块整句译文按行内链接的各自译文拆段嵌入。
   *  - 任一链接译文未回填 → 登记挂起，本次零写入，之后任意 fill/模式切换重试；
   *  - 链接单元失败 → 不写不藏（保留该链接的重试 UI，段落呈"原文+整句译文"过渡态）；
   *  - 全就位但译文对不上句序（模型改写/换序）→ 降级：整句原文替换 + 隐藏链接元素，
   *    牺牲该句可点击性换取译文不重复、不中英夹杂。 */
  private applyLinkSplit(
    container: HTMLElement,
    target: HTMLElement,
    nodes: Text[],
    trans: string,
    transEl: HTMLElement
  ): void {
    if (target.hasAttribute("data-it-inplace")) {
      transEl.classList.add("it-translated-hidden");
      return; // 此前一轮已替换完成
    }
    const unit = this.unitByContainer.get(container);
    const parts = (unit?.linkParts ?? []).filter(
      (p) => p.el.isConnected && container.contains(p.el)
    );
    const needles: string[] = [];
    for (const p of parts) {
      const t = this.linkTranslation(p);
      if (t === "pending") {
        this.pendingSplits.add(container);
        return;
      }
      if (t === "gone") {
        // 有链接失败：不嵌入（避免吞掉重试 UI 或漏一词），段落呈"原文+整句译文"过渡态；
        // 保持挂起登记，链接重试成功后的任意 fill 会补上拆段
        this.pendingSplits.add(container);
        return;
      }
      needles.push(t);
    }
    const segs = needles.length ? splitAroundTranslation(trans, needles) : [trans];
    if (!segs) {
      this.applyLinkSplitFallback(container, target, nodes, trans, transEl);
      return;
    }
    // 每个父块文本节点归属一个缝隙：gap = 文档序在它前面的链接数
    const gapOf: number[] = [];
    for (const n of nodes) {
      let g = 0;
      for (const p of parts)
        if (p.el.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) g++;
      gapOf.push(g);
    }
    // 有非空译文段的缝隙必须有落点节点，否则无法原位嵌入 → 降级
    for (let g = 0; g < segs.length; g++) {
      if (segs[g].trim() && !gapOf.includes(g)) {
        this.applyLinkSplitFallback(container, target, nodes, trans, transEl);
        return;
      }
    }
    this.snapshotOrigText(target, nodes);
    const placed = new Set<number>();
    nodes.forEach((n, i) => {
      const g = gapOf[i];
      n.textContent = placed.has(g) ? "" : segs[g];
      placed.add(g);
    });
    target.setAttribute("data-it-inplace", "");
    this.inplaceTargets.set(container, target);
    this.pendingSplits.delete(container);
    transEl.classList.add("it-translated-hidden");
  }

  /** 一个行内链接单元当前的译文文本（供父块拆段匹配） */
  private linkTranslation(part: { el: HTMLElement; text: string }): string | "pending" | "gone" {
    const el = this.byContainer.get(part.el);
    if (el?.isConnected) {
      if (el.classList.contains("it-error")) return "gone";
      const s = (el.textContent ?? "").trim();
      return s || "pending";
    }
    // 链接单元被引擎按文本去重跳过（同文已在别处译）：借用同文本兄弟单元的译文
    const shared = this.textTranslations.get(part.text);
    if (shared) return shared;
    // 链接已在别处轮次被原位翻译过（引用过期兜底）
    if (part.el.hasAttribute("data-it-inplace")) {
      const t = (part.el.firstChild?.textContent ?? "").trim();
      if (t) return t;
    }
    if (part.el.hasAttribute("data-it-src")) return "pending";
    return "pending"; // 尚在排队（如懒视口未入窗），等它回填后重试
  }

  /** 拆段失败降级：整句译文原位替换（译文本身含链接词译文）+ 隐藏原文链接避免重复 */
  private applyLinkSplitFallback(
    container: HTMLElement,
    target: HTMLElement,
    nodes: Text[],
    trans: string,
    transEl: HTMLElement
  ): void {
    this.snapshotOrigText(target, nodes);
    applyTextNodes(target, trans, nodes);
    target.setAttribute("data-it-inplace", "");
    this.inplaceTargets.set(container, target);
    const unit = this.unitByContainer.get(container);
    const hidden = new Set<HTMLElement>();
    for (const p of unit?.linkParts ?? []) {
      if (!p.el.isConnected || !container.contains(p.el)) continue;
      if (this.byContainer.get(p.el)?.classList.contains("it-error")) continue; // 失败的保留重试 UI
      p.el.setAttribute("data-it-orig-hidden", "");
      hidden.add(p.el);
    }
    this.splitHiddenLinks.set(container, hidden);
    this.pendingSplits.delete(container);
    transEl.classList.add("it-translated-hidden");
  }

  private snapshotOrigText(target: HTMLElement, nodes: Text[]): void {
    if (!target.hasAttribute("data-it-orig-text")) {
      target.setAttribute(
        "data-it-orig-text",
        JSON.stringify(nodes.map((n) => n.textContent ?? ""))
      );
    }
  }

  private clearSplitHiddenLinks(container: HTMLElement): void {
    const els = this.splitHiddenLinks.get(container);
    if (!els) return;
    for (const el of els) el.removeAttribute("data-it-orig-hidden");
    this.splitHiddenLinks.delete(container);
  }

  /** 离开仅译文：还原原文文字（仅恢复文本节点，不重建 DOM 元素），显示译文元素 */
  private clearTranslatedMode(): void {
    // 拆段降级隐藏的链接即时恢复可见；挂起的拆段父块不再等待（下次进仅译文重算）
    for (const c of [...this.splitHiddenLinks.keys()]) this.clearSplitHiddenLinks(c);
    this.pendingSplits.clear();
    // 按文档序（先序 = 祖先在前）处理：祖先恢复时其后代单元的 data-it-src 标记
    // 尚未清除，collectTextNodes 才能把嵌套单元文本排除在外，快照/恢复口径一致
    const ordered = [...this.byContainer].sort(([a], [b]) => {
      if (a === b) return 0;
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    for (const [container, transEl] of ordered) {
      if (!container.isConnected) {
        // 失连即清（留着只会泄漏），但清之前把替换文字/包裹层/标记全部解干净：
        // 虚拟列表等回收节点之后可能挂回，残留会成永久孤儿译文块（P0-1）
        this.discardContainer(container, transEl);
        this.byContainer.delete(container);
        continue;
      }
      // 包裹容器退回过 CSS 切换的（无可替换文本节点）：恢复原文可见
      if (container.hasAttribute("data-it-orig-hidden")) {
        container.removeAttribute("data-it-orig-hidden");
      }
      // 恢复原位替换的文字：目标按登记取——可能是容器自身，也可能是容器里唯一的 <a>
      //（如 <li><a>）。拆段嵌入会把父块自有文本清空，此时 getSourceTarget 启发式
      // 会误判到链接上，父块原文永远还不回来，所以必须优先用 inplaceTargets。
      const target = this.inplaceTargets.get(container) ?? getSourceTarget(container);
      this.inplaceTargets.delete(container);
      if (target.hasAttribute("data-it-inplace")) {
        const raw = target.getAttribute("data-it-orig-text");
        if (raw) restoreTextNodes(target, raw);
        target.removeAttribute("data-it-orig-text");
        target.removeAttribute("data-it-inplace");
      }
      // 显示译文元素（离开仅译文）
      if (transEl.isConnected && transEl.classList.contains("it-translated-hidden")) {
        transEl.classList.remove("it-translated-hidden");
      }
    }
    // 修复非包裹容器的 byContainer 引用：仅译文替换后译文元素是新建节点，
    // 旧引用已脱离 DOM，不更新会导致下次切换到仅译文时 in-place 替换失效
    for (const [container, transEl] of this.byContainer) {
      if (!transEl.isConnected) {
        const unitId = transEl.getAttribute("data-it-unit");
        const newEl = unitId
          ? container.querySelector<HTMLElement>(`[data-it-unit="${unitId}"]`)
          : null;
        if (newEl) {
          this.byContainer.set(container, newEl);
        } else {
          this.discardContainer(container, transEl); // 译文节点已被站点移除：原位替换的文字与标记也要还原
          this.byContainer.delete(container);
        }
      }
    }
  }

  /**
   * 彻底丢弃一个 byContainer 条目：还原原位替换文字 → 解包移除译文 → 清除全部标记。
   * 对已脱离文档的子树同样有效（DOM 读写不需要节点在文档里）——这是防孤儿残留的关键：
   * 虚拟列表/回收式渲染只是暂时摘下容器，之后可能挂回，若丢索引时不清理，
   * 重新挂载的节点带着 .it-wrap/.it-translated 与 data-it-src，永久脱离一切索引（P0-1）。
   */
  private discardContainer(container: HTMLElement, transEl: HTMLElement): void {
    // ① 撤销仅译文的原位文字替换（快照在 target——容器自身或唯一链接上）
    const target = this.inplaceTargets.get(container) ?? getSourceTarget(container);
    this.inplaceTargets.delete(container);
    if (target.hasAttribute("data-it-inplace")) {
      const raw = target.getAttribute("data-it-orig-text");
      if (raw) restoreTextNodes(target, raw);
      target.removeAttribute("data-it-orig-text");
      target.removeAttribute("data-it-inplace");
    }
    this.clearSplitHiddenLinks(container);
    container.removeAttribute("data-it-orig-hidden");
    // ② 解包：译文随包裹层移除。整棵子树已脱离 → 就地解包，让回收节点回到原始结构；
    // 包裹层在文档里但容器已被站点摘走 → 不把站点已删的原文复活，译文随包裹层摘除
    const wrap = transEl.closest?.(".it-wrap") as HTMLElement | null;
    if (wrap) {
      const orig = wrap.querySelector(":scope > .it-orig");
      if (orig && (!wrap.isConnected || container.isConnected)) wrap.before(orig);
      wrap.remove();
    } else {
      transEl.remove();
    }
    // ③ 清容器标记（removeAttribute 对脱离节点同样有效，重挂不能带着我们的状态）
    container.removeAttribute("data-it-src");
    container.classList.remove("it-orig");
    this.pendingSplits.delete(container);
    this.unitByContainer.delete(container);
  }

  /** 一键还原：解包把原文移回原位，移除全部译文与标记 */
  restore(): void {
    this.clearTranslatedMode();
    // 控件（按钮/选项）：恢复原文文字（结构始终未动）——用 controlContainers 代替 querySelectorAll
    // 失连控件同样处理：回收节点挂回时不能带着译文与标记
    for (const c of this.controlContainers) {
      const raw = c.getAttribute("data-it-ctl-orig");
      if (raw) restoreTextNodes(c, raw);
      c.removeAttribute("data-it-ctl-orig");
      c.removeAttribute("data-it-ctl-trans");
      c.removeAttribute("data-it-src"); // 控件也标记了 data-it-src，需一并清除
    }
    // 解包：原文移回原位，译文随包裹层一起移除——用 byContainer 找包裹层代替 querySelectorAll
    for (const [container, transEl] of this.byContainer) {
      this.discardContainer(container, transEl);
    }
    document.body.classList.remove("it-mode-translated", "it-mode-original");
    this.byContainer.clear();
    this.unitByContainer.clear();
    this.textTranslations.clear();
    this.pendingSplits.clear();
    this.inplaceTargets.clear();
    this.controlContainers.clear();
  }

  /** 插入译文/占位：
   * 紧凑标签 → 行内；容器本身是 flex/grid → 包裹（译文放下面，避免译文变 flex 项横排错位）；
   * 块容器 + 块级流父级 → 包裹；块容器 + flex/grid/列表/表格父级 → 插内部（保持原布局项） */
  private insert(unit: TranslationUnit, el: HTMLElement, style?: ContainerStyle): void {
    this.ensureShadowStyles(unit.container); // 容器在 shadow root 内时先补译文样式（content.css 够不着）
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
    if (prev) {
      const wrap = prev.closest(".it-wrap");
      if (wrap) {
        const orig = wrap.querySelector(":scope > .it-orig");
        if (orig) wrap.before(orig);
        wrap.remove();
        container.classList.remove("it-orig");
      } else {
        prev.remove();
      }
      this.byContainer.delete(container);
    }
    // 清理仅译文模式标记
    container.removeAttribute("data-it-orig-hidden");
    container.removeAttribute("data-it-inplace");
    this.pendingSplits.delete(container);
    this.unitByContainer.delete(container);
    this.clearSplitHiddenLinks(container);

    // 还原原位替换的文字（包裹容器也可能走过原位替换——仅译文下的链接块，
    // 不能因已解包跳过）。标记与快照在替换目标上，与 applyToContainer 同口径
    const target = this.inplaceTargets.get(container) ?? getSourceTarget(container);
    this.inplaceTargets.delete(container);
    const raw = target.getAttribute("data-it-orig-text");
    if (raw) {
      restoreTextNodes(target, raw);
      target.removeAttribute("data-it-orig-text");
    }
    target.removeAttribute("data-it-inplace");
    container.removeAttribute("data-it-src");
  }

  /** 还原单个元素承载的全部译文（悬停角标二次点击「还原」）：el 自身与内部所有
   *  已译/在途容器逐个走 clearContainer，口径与整页 restore 一致（包裹/内联/控件三形态），
   *  但不触碰页面模式类与全局状态。由外向内还原：外层恢复文字时内层容器的
   *  data-it-src 标记还在，collectTextNodes 过滤口径与捕获时一致，不会错位改写。
   *  占位态（reserve 后 fill 前）没有 data-it-src、只在 byContainer 登记——必须一并
   *  收集，否则还原正被批次套壳的段落会留下幽灵 .it-wrap + 隐形占位。 */
  restoreElement(el: HTMLElement): void {
    const targets: HTMLElement[] = [];
    if (el.hasAttribute("data-it-src") || this.byContainer.has(el)) targets.push(el);
    for (const c of el.querySelectorAll<HTMLElement>("[data-it-src]")) targets.push(c);
    for (const c of this.byContainer.keys()) {
      if ((c === el || el.contains(c)) && !targets.includes(c)) targets.push(c);
    }
    for (const c of targets) this.clearContainer(c);
  }

  /** shadow root 译文样式注入：每个 root 只建一份 sheet（WeakMap 判重防泄漏）；
   *  已存在但模式变化时仅重建样式文本。MV3 Chrome 支持 Constructable Stylesheet
   *  （adoptedStyleSheets，不占 DOM 节点）；不支持的环境回退 shadow 内 <style data-it-ui>。 */
  private ensureShadowStyles(container: HTMLElement): void {
    const root = container.getRootNode();
    if (!(root instanceof ShadowRoot)) return;
    const prev = this.shadowSheets.get(root);
    if (prev) {
      if (prev.mode !== this.mode) {
        applyShadowCss(prev.sheet, buildShadowCss(this.mode));
        prev.mode = this.mode;
      }
      return;
    }
    let sheet: CSSStyleSheet | HTMLStyleElement;
    if (supportsAdoptedStyleSheets(root)) {
      sheet = new CSSStyleSheet();
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    } else {
      const style = document.createElement("style");
      style.setAttribute("data-it-ui", ""); // 标记我们的 UI：提取与观察器按自身产物跳过
      root.appendChild(style); // 放在末尾：同特异性时晚于站点内 shadow 样式生效
      sheet = style;
    }
    applyShadowCss(sheet, buildShadowCss(this.mode));
    this.shadowSheets.set(root, { sheet, mode: this.mode });
  }

  /** 模式切换后重建各 shadow root 的样式文本（body 上的 it-mode-* 类在 shadow 内匹配不到） */
  private syncShadowStyles(): void {
    for (const container of this.byContainer.keys()) {
      const root = container.getRootNode();
      if (root instanceof ShadowRoot) this.ensureShadowStyles(container);
    }
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

/** 链接/折叠摘要一律行内（译文插元素内部，绝不给行内元素套块级包裹）；
 *  导航/页脚里的其它标签 ≤40 字符行内；正文列表项超过 24 字符用块级 */
function isCompactUILabel(unit: TranslationUnit): boolean {
  const c = unit.container;
  if (c.tagName === "A" || c.tagName === "SUMMARY") return true;
  if (c.closest("nav, header, footer")) return unit.text.length <= 40;
  if (c.tagName === "LI") return unit.text.length <= 24;
  return false;
}

/** 目标语言是否为 CJK（中文/日文/韩文）：决定 chunk 间分隔与占位长度估算 */
const CJK_TARGET_RE = /^(zh|ja|ko)/i;
const CJK_CHAR_RE = /[\u3040-\u30ff\u31f0-\u31ff\uac00-\ud7af\u4e00-\u9fff]/g;

/** 按目标语言估算译文字符数：拉丁文本 → 中文约 2 字/词；同语系按长度微放大。
 *  比直接用原文长度更贴近真实译文，占位高度更准、填充时几乎不再跳动。 */
function estimateTranslatedLength(text: string, targetLang: string): number {
  if (!CJK_TARGET_RE.test(targetLang)) return Math.ceil(text.length * 1.08);
  const latinWords = (text.match(/[A-Za-zÀ-ɏ0-9]+(?:['’-][A-Za-zÀ-ɏ0-9]+)*/g) ?? []).length;
  const cjkChars = (text.match(CJK_CHAR_RE) ?? []).length;
  return Math.ceil(latinWords * 2.1 + cjkChars * 1.1);
}

/** 估算译文占位高度：按容器宽度、真实行高与目标语言密度，保证预留空间贴近实际。
 *  style：调用方在写 DOM 前预读的样式；缺省时才回退读 getComputedStyle（会触发重排）。
 *  inline：行内控件（链接/按钮）只占一行——块级占位会在行内元素里撑出整块空白。 */
function estimateHeight(
  unit: TranslationUnit,
  style: ContainerStyle | undefined,
  targetLang: string,
  inline: boolean
): string {
  let fs: number;
  let lh: number;
  let width: number;
  if (style) {
    fs = parseFloat(style.fontSize) || 14;
    lh = parseFloat(style.lineHeight) || fs * 1.5; // computed 为 "normal" 时按 1.5 估
    width = style.width || Math.max(300, innerWidth - 40);
  } else {
    const cs = getComputedStyle(unit.container);
    fs = parseFloat(cs.fontSize) || 14;
    lh = parseFloat(cs.lineHeight) || fs * 1.5;
    width = unit.container.clientWidth || Math.max(300, innerWidth - 40);
  }
  if (inline) return `${lh}px`;
  const perLine = Math.max(10, Math.floor(width / fs));
  const estimated = estimateTranslatedLength(unit.text, targetLang);
  const lines = Math.max(1, Math.ceil(estimated / perLine));
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
// 关键设计：替换范围是「文本节点」，但绝不穿透保护元素（链接/按钮/SVG/代码等）子树，
// 也不穿透其他翻译单元的容器（data-it-src）——嵌套单元的文字归各自快照管。
// 旧实现只替换直接子级文本节点：嵌套 <span>/<b> 等内的原文会原样残留，
// 导致仅译文模式下译文与原文同屏混杂；现在统一按 collectTextNodes 深度收集后替换。

/** 保护元素：文本替换不穿透这些子树（保住链接可点击、图标、表单控件、代码展示） */
const PROTECTED_TAGS = new Set([
  "A",
  "BUTTON",
  "SELECT",
  "OPTION",
  "TEXTAREA",
  "INPUT",
  "SVG",
  "MATH",
  "CODE",
  "PRE",
  "KBD",
  "SAMP",
  "VAR",
  "SCRIPT",
  "STYLE",
  "IFRAME",
  "CANVAS",
  "IMG",
  "VIDEO",
  "AUDIO",
]);

function isProtected(el: HTMLElement): boolean {
  return (
    PROTECTED_TAGS.has(el.tagName) ||
    usesIconFont(el) || // 图标字体的 ligature 文字（home 等字形名）：动了图标就碎
    el.isContentEditable ||
    el.getAttribute("translate") === "no" ||
    el.hasAttribute("data-it-unit") || // 我们自己的译文/占位元素
    el.hasAttribute("data-it-src") || // 其他翻译单元的容器：文字归各自快照管，不越界改写
    el.hasAttribute("data-it-ui")
  );
}

/** 按各链接译文把整句译文顺序拆成 m+1 个缝隙文本（首链接前/链接之间/尾链接后）。
 *  任一 needle 找不到（模型换序/改写）返回 null → 调用方降级。
 *  匹配口径：忽略空白 + 大小写折叠回退 + 链接译文尾标点剥离——翻译模型对句内
 *  空格与标点的处理不稳定，逐字符精确匹配几乎必失。 */
export function splitAroundTranslation(trans: string, needles: string[]): string[] | null {
  const chars: string[] = [];
  const map: number[] = []; // 去空白串下标 → 原串下标
  for (let i = 0; i < trans.length; i++) {
    if (!/\s/.test(trans[i])) {
      chars.push(trans[i]);
      map.push(i);
    }
  }
  const hay = chars.join("");
  const hayLC = hay.toLowerCase();
  const gaps: string[] = [];
  let chCur = 0; // 去空白串游标：多链接必须按文档序出现，防错配到前文重复词
  let tCur = 0; // 原串游标
  for (const raw of needles) {
    const n = raw.replace(/\s+/g, "");
    if (!n) return null;
    let len = n.length;
    let idx = hay.indexOf(n, chCur);
    if (idx < 0) idx = hayLC.indexOf(n.toLowerCase(), chCur);
    if (idx < 0) {
      const bare = n.replace(/[,.;:!?、。，；：！？“”‘’"'"'()\[\]（）]+$/, "");
      if (bare && bare !== n) {
        len = bare.length;
        idx = hay.indexOf(bare, chCur);
        if (idx < 0) idx = hayLC.indexOf(bare.toLowerCase(), chCur);
      }
    }
    if (idx < 0) return null;
    gaps.push(trans.slice(tCur, map[idx]));
    tCur = map[idx + len - 1] + 1;
    chCur = idx + len;
  }
  gaps.push(trans.slice(tCur));
  return gaps;
}

/** 收集元素下的文本节点（含嵌套层级，跳过保护子树、我们的 UI 与嵌套翻译单元）。
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
 *  元素子节点本身不动；保护子树（链接/图标/控件）内的文字原样保留。
 *  nodes：调用方已收集的节点（与快照同一次收集，保证捕获/替换一一对应） */
function applyTextNodes(target: HTMLElement, translation: string, nodes?: Text[]): void {
  const list = nodes ?? collectTextNodes(target);
  if (list.length === 0) {
    target.insertBefore(document.createTextNode(translation), target.firstChild);
    return;
  }
  const hostIdx = list.findIndex((n) => (n.textContent ?? "").trim() !== "");
  const host = hostIdx >= 0 ? hostIdx : 0;
  list.forEach((n, i) => {
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

// ===== Shadow DOM 译文样式（自包含子集） =====
// content.css 注入在 light DOM，其规则（body.it-* 前缀选择器、:root 变量）不跨 shadow
// 边界生效；shadow 内的译文单元需要一份独立样式。此处从 content.css 摘出与译文 /
// 骨架屏 / data-it-* 相关的规则：
// - 模式类（body.it-mode-*）与主题类（body.it-style-*）在 shadow 内匹配不到，
//   改为按 Renderer 当前模式直出对应规则、按 body 主题类读取当前主题；
// - 自定义属性挂在 :host（:root 的定义同样进不了 shadow 树）；
// - 模式切换时整体重建样式文本（见 syncShadowStyles）。

const SHADOW_CSS_BASE = `:host{--it-error:#dc2626;--it-muted:#6b7280}
.it-translated{display:block;color:inherit;font-family:inherit;font-size:inherit;line-height:inherit;word-break:break-word;margin:8px 0;overflow-anchor:none}
.it-pending{border-radius:4px;background-color:rgba(107,114,128,.16);background-color:color-mix(in srgb,currentColor 13%,transparent);animation:it-pulse 1.8s ease-in-out infinite}
@keyframes it-pulse{0%,100%{opacity:1}50%{opacity:.45}}
@media (prefers-reduced-motion:reduce){.it-pending{animation:none}}
.it-wrap{margin:0;padding:0}
[data-it-src]{overflow-anchor:none}
.it-translated.it-inline{display:inline;margin:0 0 0 8px;vertical-align:baseline}
.it-translated.it-inline::before{content:"· ";color:var(--it-muted)}
.it-translated.it-pending.it-inline{display:inline-block;min-width:2.5em;vertical-align:baseline}
.it-translated.it-pending.it-inline::before{content:none}
.it-translated .it-chunk{display:inline;margin:0}
.it-error{color:var(--it-error)}
.it-error .it-err-text{margin-right:8px;font-size:12px}
.it-retry{border:1px solid currentColor;background:transparent;color:inherit;font-size:12px;padding:1px 8px;border-radius:4px;cursor:pointer}
.it-retry:hover{opacity:.7}
.it-translated-hidden{display:none!important}
.it-done{animation:it-fade-in .3s ease}
@keyframes it-fade-in{from{opacity:0}to{opacity:1}}`;

/** 模式相关规则直出（对应 content.css 中 body.it-mode-* 前缀的规则） */
function shadowModeCss(mode: DisplayMode): string {
  if (mode === "translated") {
    // 顺序敏感：失败块守卫（4 个类）必须能压过上面的强制显示规则
    return `.it-pending{display:none!important}
[data-it-orig-hidden]{display:none}
.it-wrap>.it-translated{display:block!important;margin:0}
.it-wrap>.it-translated.it-translated-hidden{display:none!important}`;
  }
  if (mode === "original") {
    return ".it-translated{display:none!important}";
  }
  // 双语（默认）：原文去底部外边距，让译文紧跟原文
  return ".it-wrap>.it-orig{margin-bottom:0}";
}

/** 主题规则（对应 content.css 中 body.it-style-* 前缀的规则，按当前主题直出一份） */
const SHADOW_THEME_CSS: Record<TranslationStyle, string> = {
  gray: `.it-translated .it-chunk,.it-translated.it-done.it-inline{color:#4b5563;color:color-mix(in srgb,currentColor 72%,transparent)}`,
  outline: `.it-translated .it-chunk,.it-translated.it-done.it-inline{color:inherit;-webkit-text-fill-color:transparent;-webkit-text-stroke:.6px currentColor}`,
  underline: `.it-translated .it-chunk,.it-translated.it-done.it-inline{color:inherit;text-decoration:underline dashed;text-decoration-color:#4b5563;text-decoration-color:color-mix(in srgb,currentColor 55%,transparent);text-underline-offset:3px}`,
  blur: `.it-translated .it-chunk,.it-translated.it-done.it-inline{color:inherit;filter:blur(4px);transition:filter .2s ease}
.it-translated.it-done:hover .it-chunk,.it-translated.it-done.it-inline:hover{filter:none}
@media (hover:none){.it-translated .it-chunk,.it-translated.it-done.it-inline{filter:none;color:#4b5563;color:color-mix(in srgb,currentColor 72%,transparent)}}`,
};

/** 从 body 主题类读取当前主题（style.ts 挂载，保存设置后刷新页面才变化） */
function currentStyleTheme(): TranslationStyle {
  const cls = document.body?.className ?? "";
  if (cls.includes("it-style-outline")) return "outline";
  if (cls.includes("it-style-underline")) return "underline";
  if (cls.includes("it-style-blur")) return "blur";
  return "gray";
}

function buildShadowCss(mode: DisplayMode): string {
  return [SHADOW_CSS_BASE, shadowModeCss(mode), SHADOW_THEME_CSS[currentStyleTheme()]].join("\n");
}

/** Constructable Stylesheet 可用性（jsdom 等环境无此能力，需回退 <style> 方案） */
function supportsAdoptedStyleSheets(root: ShadowRoot): boolean {
  return (
    typeof CSSStyleSheet === "function" &&
    typeof CSSStyleSheet.prototype.replaceSync === "function" &&
    "adoptedStyleSheets" in root
  );
}

function applyShadowCss(sheet: CSSStyleSheet | HTMLStyleElement, css: string): void {
  if (sheet instanceof CSSStyleSheet) sheet.replaceSync(css);
  else sheet.textContent = css;
}
