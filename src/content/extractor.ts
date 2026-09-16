/** 文本节点提取与分块（阶段 3） */
import { createWorkPacer, pauseIfBudgetSpent } from "./scheduler";

export interface TranslationUnit {
  /** 自增 id（内容脚本在 http 页面上不能用 crypto.randomUUID） */
  id: string;
  /** 译文插到该元素之后（表格类限制容器则插到内部末尾） */
  container: HTMLElement;
  /** 单元完整文本（去重键 / 原文） */
  text: string;
  /** 句子分块后的译文请求单元 */
  chunks: string[];
  /** 交互控件（button/option）：仅文本原位替换，不插入译文元素、不改 DOM 结构 */
  textOnly?: boolean;
  /** 含行内链接的块单元：text 保留链接文字（API 必须看到完整源句），子树内锚定到
   *  <a> 的链接单元按文档序列出于此。仅译文渲染时把整句译文按链接译文拆段嵌入缝隙，
   *  链接文字原位替换为各自译文——既无破碎源句，也不重复显示。 */
  linkParts?: { el: HTMLElement; text: string }[];
  /** 调度批次令牌（engine.translateUnits 赋值，与容器 data-it-processing 的值同源）：
   *  单元素还原/重排后容器标记被摘掉或换新令牌，渲染时比对失配 → 该单元被丢弃，
   *  保证还原后的段落不会被仍在途的旧批次回填译文 */
  batchToken?: string;
}

export interface ExtractOptions {
  minTextLength: number;
  blockMaxChars: number;
  targetLang: string;
  /** 站点规则：不翻译的标签（大小写变体已收录，shared/siteRules 的 resolveSiteRules 产出） */
  excludeTags?: ReadonlySet<string>;
  /** 站点规则：强制按块级容器处理的标签 */
  forceBlockTags?: ReadonlySet<string>;
  /** 站点规则：排除区选择器（已逐条校验合并；命中元素及其子树不翻译） */
  excludeSelector?: string | null;
}

/** 巨型段落拆分阈值：单个文本块超过该长度时，在句子边界拆分为多个子单元（chunk）。
 *  超高段落（超长小说章节/评论区）若整块进批量管线，会产生远超上限的畸形 chunk
 *  或让单批请求过大超时；拆分后各子单元独立进批、独立渲染，互不影响。 */
export const CHUNK_SPLIT_CHARS = 1200;

/**
 * 不参与翻译的标签（文本在这些标签内一律跳过）。
 * 注：BUTTON / OPTION / SELECT 不再整体排除——下拉菜单、点击展开的选项
 * 多为这类控件。它们改走“仅文本原位替换”（见 getControlEl 与 Renderer 的
 * textOnly 处理）：只改文字不改 DOM 结构，点击展开/选中交互不受影响。
 * （导出供属性翻译的元素过滤复用）
 */
export const EXCLUDED_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "IFRAME",
  "SVG",
  "MATH",
  "CODE",
  "PRE",
  "KBD",
  "SAMP",
  "VAR",
  "TEXTAREA",
  "INPUT",
]);

/** 作为“翻译单元容器”候选的块级元素 */
const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "LI",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BLOCKQUOTE",
  "TD",
  "TH",
  "TR",
  "TABLE",
  "DD",
  "DT",
  "FIGCAPTION",
  "SUMMARY",
  "ADDRESS",
  "SECTION",
  "ARTICLE",
  "HEADER",
  "FOOTER",
  "MAIN",
  "UL",
  "OL",
]);

let seq = 0;

/** 遍历 root，返回翻译单元列表（已按容器分组并过滤）。
 *  遍历范围除 light DOM 外还进入 open shadow root（见 walkTextNodes）。
 *  性能要点（大页面卡顿修复）：isHiddenElement 依赖 getComputedStyle，代价高；
 *  同一次扫描内对每个元素的"是否隐藏/是否处于排除区"做记忆化，
 *  把 O(文本节点数 × 祖先深度) 次样式计算降到 O(去重元素数)。 */
export function extractUnits(root: HTMLElement, opts: ExtractOptions): TranslationUnit[] {
  const grouped = new Map<HTMLElement, Text[]>();
  const hiddenCache = new Map<HTMLElement, boolean>();
  const excludedSubtreeCache = new Map<HTMLElement, boolean>();
  const idCache = new Map<string, boolean>();

  for (const t of walkTextNodes(root, opts, hiddenCache, excludedSubtreeCache, idCache)) {
    // 一次向上遍历同时判定 control / standalone link / block container，
    // 避免原来三个函数各自独立爬祖先链（O(3×深度) → O(深度)）
    const container = resolveContainer(t, opts);
    if (container === document.body) continue;
    let list = grouped.get(container);
    if (!list) grouped.set(container, (list = []));
    list.push(t);
  }

  return buildUnitsFromGrouped(grouped, opts);
}

/**
 * extractUnits 的时间片版本（借鉴 read-frog 的 chunked walk）：
 * 逻辑与 extractUnits 完全一致，但在遍历与构建单元的过程中，每花完一个时间片
 * 预算就 `yield` 让出主线程，避免超大页面的整页扫描一次性冻结浏览器。
 * @param shouldContinue 每次让出后检查；返回 false 时中止并返回已收集的单元。
 */
export async function extractUnitsChunked(
  root: HTMLElement,
  opts: ExtractOptions,
  shouldContinue: () => boolean = () => true
): Promise<TranslationUnit[]> {
  const grouped = new Map<HTMLElement, Text[]>();
  const hiddenCache = new Map<HTMLElement, boolean>();
  const excludedSubtreeCache = new Map<HTMLElement, boolean>();
  const idCache = new Map<string, boolean>();
  const pacer = createWorkPacer();

  for (const t of walkTextNodes(root, opts, hiddenCache, excludedSubtreeCache, idCache)) {
    // 一次向上遍历同时判定 control / standalone link / block container
    const container = resolveContainer(t, opts);
    if (container !== document.body) {
      let list = grouped.get(container);
      if (!list) grouped.set(container, (list = []));
      list.push(t);
    }
    // 时间片预算花完 → 让出主线程；让出后若会话已失效则中止
    if (performance.now() >= pacer.deadline) {
      await pauseIfBudgetSpent(pacer);
      if (!shouldContinue()) return buildUnitsFromGrouped(grouped, opts);
    }
  }

  return buildUnitsFromGrouped(grouped, opts);
}

/** DOM 文档序比较（compareDocumentPosition 包装） */
function compareInDoc(a: Node, b: Node): number {
  if (a === b) return 0;
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

/** 把已分组的文本节点构建成翻译单元（供同步/分片两个入口复用）。
 *  行内链接的关键约定：锚定到 <a> 的链接单元只决定「替换归属」，不决定「送翻内容」——
 *  父块的 unit.text 会把链接文字并回原位（完整源句进 API，防止「The is a country」
 *  式破碎句），链接译文如何显示由渲染层依 linkParts 处理（原位替换 + 整句译文拆段嵌入）。 */
function buildUnitsFromGrouped(
  grouped: Map<HTMLElement, Text[]>,
  opts: ExtractOptions
): TranslationUnit[] {
  const groupKeys = new Set(grouped.keys());
  // 第一遍：链接组按自身文字判定是否值得翻译，并找归属块
  const keptLinks = new Map<HTMLElement, { nodes: Text[]; text: string }>();
  const blockOfLink = new Map<HTMLElement, HTMLElement>();
  for (const [container, nodes] of grouped) {
    if (container.tagName !== "A") continue;
    const text = joinTextNodes(nodes);
    if (!shouldTranslate(text, opts, container)) continue;
    keptLinks.set(container, { nodes, text });
    let p = container.parentElement;
    while (p && p !== document.body) {
      if (groupKeys.has(p)) {
        if (p.tagName !== "A") blockOfLink.set(container, p);
        break;
      }
      p = p.parentElement;
    }
  }
  // 每块的链接部件（文档序）
  const linksByBlock = new Map<HTMLElement, { el: HTMLElement; text: string }[]>();
  for (const [el, b] of blockOfLink) {
    const kept = keptLinks.get(el);
    if (!kept) continue;
    const list = linksByBlock.get(b) ?? [];
    list.push({ el, text: kept.text });
    linksByBlock.set(b, list);
  }

  const units: TranslationUnit[] = [];
  for (const [container, nodes] of grouped) {
    let text: string;
    let linkParts: { el: HTMLElement; text: string }[] | undefined;
    if (container.tagName === "A") {
      const kept = keptLinks.get(container);
      if (!kept) continue; // 不值得翻译的链接：单元整个丢弃（文字也不并回父句）
      text = kept.text;
    } else {
      const parts = linksByBlock.get(container);
      if (parts?.length) {
        parts.sort((a, b) => compareInDoc(a.el, b.el));
        const merged: Text[] = [...nodes];
        for (const p of parts) merged.push(...(keptLinks.get(p.el)?.nodes ?? []));
        merged.sort(compareInDoc);
        linkParts = parts;
        text = joinTextNodes(merged);
      } else {
        text = joinTextNodes(nodes);
      }
      if (!shouldTranslate(text, opts, container)) continue;
    }
    units.push({
      id: `it-${++seq}`,
      container,
      text,
      chunks: splitUnitChunks(text, opts.blockMaxChars),
      textOnly: isControl(container),
      linkParts,
    });
  }
  return units;
}

/** 跨域遍历文本节点：先 light DOM，再 root 内所有 open shadow root，同一节点只产出一次。
 *  TreeWalker 不穿透 shadow 边界，shadow 内容必须按域分别建 walker；
 *  各域子树互不相交，slot 分发的 light DOM 文本仍属 light 树，故不会重复访问。 */
function* walkTextNodes(
  root: HTMLElement,
  opts: ExtractOptions,
  hiddenCache: Map<HTMLElement, boolean>,
  excludedCache: Map<HTMLElement, boolean>,
  idCache: Map<string, boolean>
): Generator<Text> {
  const acceptNode = (node: Node): number => {
    const t = node as Text;
    if (!t.textContent || !t.textContent.trim()) return NodeFilter.FILTER_REJECT;
    if (isExcluded(t, opts, hiddenCache, excludedCache, idCache)) return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT;
  };
  // 1) light DOM（含 slot 分发的宿主子节点）
  let walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode });
  let n: Node | null;
  while ((n = walker.nextNode())) yield n as Text;
  // 2) 各 open shadow root：过滤规则与 light DOM 相同，宿主侧排除状态单独判定
  for (const scope of collectShadowRoots(root)) {
    if (isShadowScopeExcluded(scope.host, opts)) continue;
    walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, { acceptNode });
    while ((n = walker.nextNode())) yield n as Text;
  }
}

/** 收集 root 下所有需要独立遍历的 open shadow root（含嵌套 shadow，按文档序）。
 *  仅做 shadowRoot 属性检查的轻量元素趟；shadow 树无环，每域恰好入栈一次。 */
function collectShadowRoots(root: HTMLElement): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  if (root.shadowRoot) roots.push(root.shadowRoot); // root 自身可能是宿主（观察器会以宿主为根补扫）
  const visit = (scope: Node): void => {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const shadow = (n as Element).shadowRoot;
      if (shadow) {
        roots.push(shadow);
        visit(shadow); // shadow 内再挂 shadow：递归收集嵌套域
      }
    }
  };
  visit(root);
  return roots;
}

/** shadow 域是否整体跳过：宿主不可见，或宿主自身及其 light 祖先带排除标记 / 命中站点规则。
 *  shadow 内文本的祖先链不跨 shadow 边界，宿主侧的排除状态需在此单独判定。 */
function isShadowScopeExcluded(host: Element, opts: ExtractOptions): boolean {
  for (let el: Element | null = host; el; el = el.parentElement) {
    if (
      el.hasAttribute("data-it-ui") ||
      (el instanceof HTMLElement && el.isContentEditable) ||
      el.hasAttribute("hidden") ||
      el.getAttribute("aria-hidden") === "true" ||
      el.getAttribute("translate") === "no"
    ) {
      return true;
    }
    if (opts.excludeTags?.size && opts.excludeTags.has(el.tagName)) return true;
    if (opts.excludeSelector && el.matches(opts.excludeSelector)) return true;
  }
  return isHiddenElement(host as HTMLElement);
}

/** 元素是否视觉隐藏：display:none / visibility:hidden / sr-only 式屏幕阅读器隐藏 */
function isHiddenElement(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden") return true;
  // sr-only / visually-hidden：绝对定位 + 极小尺寸（如 GitHub 侧栏的 sr-only 标题）
  if (cs.position === "absolute" || cs.position === "fixed") {
    const r = el.getBoundingClientRect();
    if (r.width <= 2 && r.height <= 2) return true;
  }
  return false;
}

/** 文本节点是否位于排除区域（标签 / 属性 / 可编辑 / 站内锚点链接 / 视觉隐藏）。
 *  性能要点：excludedCache 记忆"该元素自身或任一祖先是否被排除"——
 *  命中缓存即可立刻返回（大量文本节点共享祖先，避免重复向上爬 + 重复样式计算）。 */
function isExcluded(
  node: Text,
  opts: ExtractOptions,
  hiddenCache: Map<HTMLElement, boolean>,
  excludedCache: Map<HTMLElement, boolean>,
  idCache: Map<string, boolean>
): boolean {
  const chain: HTMLElement[] = [];
  let el: HTMLElement | null = node.parentElement;
  let ancestorExcluded = false;
  while (el && el !== document.body) {
    const cached = excludedCache.get(el);
    if (cached !== undefined) {
      ancestorExcluded = cached;
      break;
    }
    chain.push(el);
    el = el.parentElement;
  }
  // 自最浅祖先向 node 方向逐层累计并写缓存：cum = 自身被排除 || 更上层已被排除
  let cum = ancestorExcluded;
  for (let i = chain.length - 1; i >= 0; i--) {
    const e = chain[i];
    cum = isSelfExcluded(e, opts, hiddenCache, idCache) || cum;
    excludedCache.set(e, cum);
  }
  return cum;
}

/** 图标字体族（ligature 图标）：这类元素里的文字（home / shopping_cart / menu）是
 *  字形名，由图标字体连字渲染成图标。翻译会破坏连字查找——图标退化成一段中文/英文
 *  垃圾文字，所在句子也被掺进臆造词。命中 font-family 即整棵子树不参与翻译/替换。 */
const ICON_FONT_FAMILY_RE =
  /material\s*[- ]?\s*(icons?|symbols)|iconfont|font\s*awesome|feather|lucide|tabler[\s-]*icons?|remix[\s-]*icons?|bootstrap[\s-]*icons?|box[\s-]*icons?|ionicons?|codicons?|unicons?|phosphor|heroicons?|icomoon|entypo|typicons?|glyphicons|pixelarticons|streamline|segoe[\s-]*(mdl2|fluent)|fluent[\s-]*system[\s-]*icons?/i;
const iconFontCache = new WeakMap<HTMLElement, boolean>();

/** 元素是否以图标字体渲染（文字是字形名而非文案）。无布局环境（jsdom）拿不到
 *  真实 font-family → 恒 false，不影响单测。 */
export function usesIconFont(el: HTMLElement): boolean {
  let v = iconFontCache.get(el);
  if (v === undefined) {
    let ff = "";
    try {
      ff = getComputedStyle(el).fontFamily ?? "";
    } catch {
      ff = "";
    }
    v = ff ? ICON_FONT_FAMILY_RE.test(ff) : false;
    iconFontCache.set(el, v);
  }
  return v;
}

/** 单个元素自身是否应排除（不含祖先）。隐藏判定走 hiddenCache 记忆化，避免重复 getComputedStyle。
 *  idCache 记忆 document.getElementById 结果，避免链接密集页面重复全局查找。 */
function isSelfExcluded(
  el: HTMLElement,
  opts: ExtractOptions,
  hiddenCache: Map<HTMLElement, boolean>,
  idCache: Map<string, boolean>
): boolean {
  if (EXCLUDED_TAGS.has(el.tagName)) return true;
  // 图标字体的 ligature 文字（home/shopping_cart 等字形名）不是文案，永不翻译
  if (usesIconFont(el)) return true;
  // 站点规则：不翻译的标签 / 排除区选择器。选择器只需自匹配——祖先命中会经 cum 传导给整棵子树
  if (opts.excludeTags?.size && opts.excludeTags.has(el.tagName)) return true;
  if (opts.excludeSelector && el.matches(opts.excludeSelector)) return true;
  let hidden = hiddenCache.get(el);
  if (hidden === undefined) {
    hidden = isHiddenElement(el);
    hiddenCache.set(el, hidden);
  }
  if (hidden) return true;
  // 我们注入的译文/占位/UI 元素不参与提取
  if (el.hasAttribute("data-it-unit") || el.hasAttribute("data-it-ui")) return true;
  // 仅跳过真正的页内跳转锚点（如 "Skip to content"，目标 ID 存在）；
  // href="#" 触发 JS 的链接（如 Manage cookies）不跳过，正常翻译
  if (el.tagName === "A") {
    const href = el.getAttribute("href") ?? "";
    if (href.length > 1 && href.startsWith("#")) {
      const id = href.slice(1);
      let exists = idCache.get(id);
      if (exists === undefined) {
        exists = !!document.getElementById(id);
        idCache.set(id, exists);
      }
      if (exists) return true;
    }
  }
  if (el.isContentEditable) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  if (el.hidden) return true;
  if (el.getAttribute("translate") === "no") return true;
  return false;
}

/** 一次向上遍历同时判定 control / link / block container。
 *  替代原来 getControlEl → getStandaloneLink → nearestBlockContainer 三次独立爬祖先。
 *  返回锚定容器（控件 / 链接 / 块级容器），或 document.body 表示跳过。 */
function resolveContainer(node: Text, opts: ExtractOptions): HTMLElement {
  let el: HTMLElement | null = node.parentElement;
  if (!el) return document.body;
  let current: HTMLElement = el;
  let foundControl: HTMLElement | null = null;
  let foundLink: HTMLElement | null = null;
  while (current !== document.body) {
    const parent = current.parentElement;
    if (!parent || parent === document.body) break;
    if (foundControl === null && isControl(current)) foundControl = current;
    if (foundLink === null && current.tagName === "A") foundLink = current;
    // 站点规则的「强制块级」与内置块级标签同权：命中即把该自定义元素锚定为独立单元
    if (
      BLOCK_TAGS.has(current.tagName) ||
      (opts.forceBlockTags?.size && opts.forceBlockTags.has(current.tagName))
    ) {
      break;
    }
    current = parent;
  }
  // 控件优先：按钮/选项锚定到控件自身
  if (foundControl) return foundControl;
  // 链接文字一律锚定到 <a> 自身（含正文段落里的行内链接）：仅译文模式下链接文字
  // 也要被原位替换为译文——旧版只拆导航菜单链接，正文行内链接的文字被保护子树
  // 留在原地，表现为「句子翻了一半、夹着英文」。锚定到链接后 href/结构不动，
  // 点击跳转不受影响；块级元素里的文字照常锚定到块（爬到块级即 break，够不到外层链接）。
  // 注意：这只是「替换归属」的拆分；父块送 API 的源句在 buildUnitsFromGrouped 里
  // 会把链接文字并回（完整语义进请求），渲染层按 linkParts 拆段嵌入，不重复显示。
  if (foundLink) return foundLink;
  // 否则锚定到最近的块级容器
  return current;
}

/** 交互控件：按钮 / 下拉选项（菜单选项、点击展开的条目多为这类） */
function isControl(el: HTMLElement): boolean {
  return el.tagName === "BUTTON" || el.tagName === "OPTION";
}

/** 拼接容器内文本节点；相邻换行标签（br / 块级）转成空格 */
function joinTextNodes(nodes: Text[]): string {
  let text = "";
  for (const n of nodes) {
    text += n.textContent ?? "";
    const sib = n.nextSibling;
    if (
      sib &&
      (sib.nodeName === "BR" || (sib.nodeType === 1 && BLOCK_TAGS.has((sib as Element).tagName)))
    ) {
      text += " ";
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

/** 单元是否为链接：容器是 <a>，或直接包着一个 <a>（如 <li><a>、<div><a>） */
function isLinkLike(container: HTMLElement): boolean {
  if (container.tagName === "A") return true;
  for (const child of Array.from(container.children)) {
    if (child.tagName === "A") return true;
  }
  return false;
}

/** 单元是否值得翻译：够长、含字母、且不是目标语言 */
function shouldTranslate(
  text: string,
  opts: ExtractOptions,
  container?: HTMLElement | null
): boolean {
  // 链接与控件（按钮/选项）里的短词（FAQ/AI/Save/Delete 等）门槛放低到 2 字符；正文仍按 minTextLength
  const minLen =
    container && (isLinkLike(container) || isControl(container)) ? 2 : opts.minTextLength;
  if (text.length < minLen) return false;
  if (!LETTER_RE.test(text)) return false;
  if (isTargetLanguage(text, opts.targetLang)) return false;
  return true;
}

/** 字母判定（含拉丁扩展/假名/韩文/汉字）：导出供属性翻译复用 */
export const LETTER_RE = /[A-Za-zÀ-ɏ぀-ヿ가-힣一-鿿]/;

/** 目标语言启发式：文本是否不含任何需翻译的字符（纯目标语言文本可跳过）。
 *  含拉丁字母、假名、韩文等外来字符即视为需要翻译，即使目标语言字符占比较高。
 *  这样确保「中英混合」段落的英文术语也会被翻译。 */
export function isTargetLanguage(text: string, targetLang: string): boolean {
  const letters = text.replace(/[^A-Za-zÀ-ɏ぀-ヿ가-힣一-鿿]/g, "");
  if (!letters) return false;
  if (/^zh/i.test(targetLang)) {
    // 含拉丁/假名/韩文等外来字符 → 需要翻译
    const foreign = (letters.match(/[A-Za-zÀ-ɏ぀-ヿ가-힣]/g) ?? []).length;
    return foreign === 0;
  }
  if (/^ja/i.test(targetLang)) {
    // 含拉丁/韩文等外来字符 → 需要翻译
    const foreign = (letters.match(/[A-Za-zÀ-ɏ가-힣]/g) ?? []).length;
    return foreign === 0;
  }
  if (/^ko/i.test(targetLang)) {
    // 含拉丁/假名/汉字等外来字符 → 需要翻译
    const foreign = (letters.match(/[A-Za-zÀ-ɏ぀-ヿ一-鿿]/g) ?? []).length;
    return foreign === 0;
  }
  // 拉丁语系目标语言：含非拉丁字符则需要翻译
  const nonLatin = (letters.match(/[^A-Za-zÀ-ɏ]/g) ?? []).length;
  return nonLatin === 0;
}

/** 句子边界：中文句读（。！？!?…；;）后必切；英文句读（.!?;）后跟空白才切——
 *  "3.14"、"e.g" 中的句点不切。split 消费掉边界处空白，token 内部空白保留。 */
const SENTENCE_SPLIT_RE = /(?<=[。！？!?…；;])|(?<=[.!?;])\s+/;

/** 超长文本按句子聚簇切分，每块控制在 maxChars 以内（导出供单元测试）：
 *  1) 按句子边界 token 化，单个无边界 token 超限时按硬上限强切，全程不产生空段；
 *  2) 聚簇目标块大小 = 总长/块数（块数按硬上限估算），各块尽量均衡，
 *     避免「前满后尖」——老实现贪心填满上限，最后一块只剩零头。 */
export function splitBySentences(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const pieces: string[] = [];
  for (const token of text.split(SENTENCE_SPLIT_RE)) {
    const t = token.trim();
    if (!t) continue;
    if (t.length <= maxChars) {
      pieces.push(t);
    } else {
      for (let i = 0; i < t.length; i += maxChars) pieces.push(t.slice(i, i + maxChars));
    }
  }
  if (pieces.length === 0) return [text];
  const totalLen = pieces.reduce((sum, p) => sum + p.length, 0) + (pieces.length - 1);
  const target = Math.max(1, Math.ceil(totalLen / Math.ceil(totalLen / maxChars)));
  const chunks: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur && (cur.length + 1 + p.length > maxChars || cur.length >= target)) {
      chunks.push(cur);
      cur = p;
    } else {
      cur = cur ? cur + " " + p : p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** 单元 chunk 计算：上限取用户设置与 CHUNK_SPLIT_CHARS 的较小值——
 *  用户调小 blockMaxChars 时尊重其设置；调大时巨型文本仍按 CHUNK_SPLIT_CHARS
 *  拆分，保住批量管线的体积假设。 */
function splitUnitChunks(text: string, blockMaxChars: number): string[] {
  return splitBySentences(text, Math.min(blockMaxChars, CHUNK_SPLIT_CHARS));
}
