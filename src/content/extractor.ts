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
}

export interface ExtractOptions {
  minTextLength: number;
  blockMaxChars: number;
  targetLang: string;
}

/**
 * 不参与翻译的标签（文本在这些标签内一律跳过）。
 * 注：BUTTON / OPTION / SELECT 不再整体排除——下拉菜单、点击展开的选项
 * 多为这类控件。它们改走“仅文本原位替换”（见 getControlEl 与 Renderer 的
 * textOnly 处理）：只改文字不改 DOM 结构，点击展开/选中交互不受影响。
 * （导出供属性翻译的元素过滤复用）
 */
export const EXCLUDED_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "SVG", "MATH", "CODE", "PRE",
  "KBD", "SAMP", "VAR", "TEXTAREA", "INPUT",
]);

/** 作为“翻译单元容器”候选的块级元素 */
const BLOCK_TAGS = new Set([
  "P", "DIV", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE",
  "TD", "TH", "TR", "TABLE", "DD", "DT", "FIGCAPTION", "SUMMARY", "ADDRESS",
  "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "UL", "OL",
]);

let seq = 0;

/** 遍历 root，返回翻译单元列表（已按容器分组并过滤）。
 *  性能要点（大页面卡顿修复）：isHiddenElement 依赖 getComputedStyle，代价高；
 *  同一次扫描内对每个元素的"是否隐藏/是否处于排除区"做记忆化，
 *  把 O(文本节点数 × 祖先深度) 次样式计算降到 O(去重元素数)。 */
export function extractUnits(root: HTMLElement, opts: ExtractOptions): TranslationUnit[] {
  const grouped = new Map<HTMLElement, Text[]>();
  const hiddenCache = new Map<HTMLElement, boolean>();
  const excludedSubtreeCache = new Map<HTMLElement, boolean>();
  const idCache = new Map<string, boolean>();

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const t = node as Text;
      if (!t.textContent || !t.textContent.trim()) return NodeFilter.FILTER_REJECT;
      if (isExcluded(t, hiddenCache, excludedSubtreeCache, idCache)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const t = node as Text;
    // 一次向上遍历同时判定 control / standalone link / block container，
    // 避免原来三个函数各自独立爬祖先链（O(3×深度) → O(深度)）
    const container = resolveContainer(t);
    if (container === document.body) continue;
    let list = grouped.get(container);
    if (!list) grouped.set(container, (list = []));
    list.push(t);
  }

  const units: TranslationUnit[] = [];
  for (const [container, nodes] of grouped) {
    const text = joinTextNodes(nodes);
    if (!shouldTranslate(text, opts, container)) continue;
    units.push({
      id: `it-${++seq}`,
      container,
      text,
      chunks: splitBySentences(text, opts.blockMaxChars),
      textOnly: isControl(container),
    });
  }
  return units;
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

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const t = node as Text;
      if (!t.textContent || !t.textContent.trim()) return NodeFilter.FILTER_REJECT;
      if (isExcluded(t, hiddenCache, excludedSubtreeCache, idCache)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const t = node as Text;
    // 一次向上遍历同时判定 control / standalone link / block container
    const container = resolveContainer(t);
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

/** 把已分组的文本节点构建成翻译单元（供同步/分片两个入口复用） */
function buildUnitsFromGrouped(
  grouped: Map<HTMLElement, Text[]>,
  opts: ExtractOptions
): TranslationUnit[] {
  const units: TranslationUnit[] = [];
  for (const [container, nodes] of grouped) {
    const text = joinTextNodes(nodes);
    if (!shouldTranslate(text, opts, container)) continue;
    units.push({
      id: `it-${++seq}`,
      container,
      text,
      chunks: splitBySentences(text, opts.blockMaxChars),
      textOnly: isControl(container),
    });
  }
  return units;
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
    cum = isSelfExcluded(e, hiddenCache, idCache) || cum;
    excludedCache.set(e, cum);
  }
  return cum;
}

/** 单个元素自身是否应排除（不含祖先）。隐藏判定走 hiddenCache 记忆化，避免重复 getComputedStyle。
 *  idCache 记忆 document.getElementById 结果，避免链接密集页面重复全局查找。 */
function isSelfExcluded(
  el: HTMLElement,
  hiddenCache: Map<HTMLElement, boolean>,
  idCache: Map<string, boolean>
): boolean {
  if (EXCLUDED_TAGS.has(el.tagName)) return true;
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

/** 一次向上遍历同时判定 control / standalone link / block container。
 *  替代原来 getControlEl → getStandaloneLink → nearestBlockContainer 三次独立爬祖先。
 *  返回锚定容器（控件 / 链接 / 块级容器），或 document.body 表示跳过。 */
function resolveContainer(node: Text): HTMLElement {
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
    if (BLOCK_TAGS.has(current.tagName)) break;
    current = parent;
  }
  // 控件优先：按钮/选项锚定到控件自身
  if (foundControl) return foundControl;
  // 独立菜单/导航链接：锚定到链接自身（避免多个链接合并成一块译文）
  if (foundLink && isStandaloneLink(foundLink)) return foundLink;
  // 否则锚定到最近的块级容器
  return current;
}

/** 交互控件：按钮 / 下拉选项（菜单选项、点击展开的条目多为这类） */
function isControl(el: HTMLElement): boolean {
  return el.tagName === "BUTTON" || el.tagName === "OPTION";
}

/** 判断 <a> 是否为独立菜单/导航链接（应单独成单元）。
 *  父级为 nav/ul/ol/header/footer，或父级只含链接（和空白文本）→ 是菜单 */
function isStandaloneLink(a: HTMLElement): boolean {
  const parent = a.parentElement;
  if (!parent) return false;
  if (NAV_PARENT_TAGS.has(parent.tagName)) return true;
  // 父级只含链接（和空白文本）→ 是菜单，拆开每个链接
  const kids = parent.childNodes;
  let linkCount = 0;
  let onlyLinksAndWhitespace = true;
  for (const c of kids) {
    if (c.nodeName === "A") {
      linkCount++;
    } else if (c.nodeType === 3) {
      if (c.textContent?.trim()) onlyLinksAndWhitespace = false;
    } else {
      onlyLinksAndWhitespace = false;
    }
  }
  return linkCount >= 2 && onlyLinksAndWhitespace;
}

const NAV_PARENT_TAGS = new Set(["NAV", "UL", "OL", "HEADER", "FOOTER"]);

/** 拼接容器内文本节点；相邻换行标签（br / 块级）转成空格 */
function joinTextNodes(nodes: Text[]): string {
  let text = "";
  for (const n of nodes) {
    text += n.textContent ?? "";
    const sib = n.nextSibling;
    if (sib && (sib.nodeName === "BR" || (sib.nodeType === 1 && BLOCK_TAGS.has((sib as Element).tagName)))) {
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
  const minLen = container && (isLinkLike(container) || isControl(container)) ? 2 : opts.minTextLength;
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

/** 超长文本按句子切分，每块控制在 maxChars 以内（导出供单元测试） */
export function splitBySentences(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const sentences = text
    .split(/(?<=[。！？.!?…；;])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (!cur || (cur + " " + s).length <= maxChars) {
      cur = cur ? cur + " " + s : s;
    } else {
      chunks.push(cur);
      cur = s;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}
