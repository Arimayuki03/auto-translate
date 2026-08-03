/** 文本节点提取与分块（阶段 3） */

export interface TranslationUnit {
  /** 自增 id（内容脚本在 http 页面上不能用 crypto.randomUUID） */
  id: string;
  /** 译文插到该元素之后（表格类限制容器则插到内部末尾） */
  container: HTMLElement;
  /** 单元完整文本（去重键 / 原文） */
  text: string;
  /** 句子分块后的译文请求单元 */
  chunks: string[];
}

export interface ExtractOptions {
  minTextLength: number;
  blockMaxChars: number;
  targetLang: string;
}

/** 不参与翻译的标签（文本在这些标签内一律跳过；按钮是交互控件，翻译会改变其位置） */
const EXCLUDED_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "SVG", "MATH", "CODE", "PRE",
  "KBD", "SAMP", "VAR", "TEXTAREA", "INPUT", "SELECT", "OPTION", "BUTTON",
]);

/** 作为“翻译单元容器”候选的块级元素 */
const BLOCK_TAGS = new Set([
  "P", "DIV", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE",
  "TD", "TH", "TR", "TABLE", "DD", "DT", "FIGCAPTION", "SUMMARY", "ADDRESS",
  "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "UL", "OL",
]);

let seq = 0;

/** 遍历 root，返回翻译单元列表（已按容器分组并过滤） */
export function extractUnits(root: HTMLElement, opts: ExtractOptions): TranslationUnit[] {
  const grouped = new Map<HTMLElement, Text[]>();

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const t = node as Text;
      if (!t.textContent || !t.textContent.trim()) return NodeFilter.FILTER_REJECT;
      if (isExcluded(t)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const t = node as Text;
    // 独立菜单/导航链接 → 锚定到链接自身，避免多个链接合并成一块译文
    const container = getStandaloneLink(t) ?? nearestBlockContainer(t);
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

/** 文本节点是否位于排除区域（标签 / 属性 / 可编辑 / 站内锚点链接 / 视觉隐藏） */
function isExcluded(node: Text): boolean {
  for (
    let el: HTMLElement | null = node.parentElement;
    el && el !== document.body;
    el = el.parentElement
  ) {
    if (EXCLUDED_TAGS.has(el.tagName)) return true;
    if (isHiddenElement(el)) return true;
    // 仅跳过真正的页内跳转锚点（如 "Skip to content"，目标 ID 存在）；
    // href="#" 触发 JS 的链接（如 Manage cookies）不跳过，正常翻译
    if (el.tagName === "A") {
      const href = el.getAttribute("href") ?? "";
      if (href.length > 1 && href.startsWith("#") && document.getElementById(href.slice(1))) {
        return true;
      }
    }
    if (el.hasAttribute("data-it-unit") || el.hasAttribute("data-it-ui")) return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    if (el.hidden) return true;
    if (el.getAttribute("translate") === "no") return true;
  }
  return false;
}

/** 向上找最近的块级容器（不超过 body 的直接子元素） */
function nearestBlockContainer(node: Text): HTMLElement {
  let el = node.parentElement;
  if (!el) return document.body;
  let current: HTMLElement = el;
  while (current !== document.body) {
    const parent = current.parentElement;
    if (!parent || parent === document.body) break;
    if (BLOCK_TAGS.has(current.tagName)) break;
    current = parent;
  }
  return current;
}

/**
 * 独立菜单/导航链接：文本在 <a> 内，且该 <a> 平铺在导航容器（nav/ul/ol/header/footer）
 * 或「父级只有 <a> 子元素」的菜单里。这种链接应单独成单元，避免多个链接合并成一块译文
 * 塞进容器末尾，导致页面中间出现多余的译文。
 */
function getStandaloneLink(node: Text): HTMLElement | null {
  let a: HTMLElement | null = null;
  for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) {
    if (el.tagName === "A") {
      a = el;
      break;
    }
  }
  if (!a || !a.parentElement) return null;
  const parent = a.parentElement;
  if (["NAV", "UL", "OL", "HEADER", "FOOTER"].includes(parent.tagName)) return a;
  // 父级只含链接（和空白文本）→ 是菜单，拆开每个链接
  const kids = Array.from(parent.childNodes);
  const links = kids.filter((c) => c.nodeName === "A");
  const onlyLinks =
    links.length >= 2 &&
    kids.every((c) => c.nodeName === "A" || (c.nodeType === 3 && !c.textContent?.trim()));
  return onlyLinks ? a : null;
}

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
  // 链接里的英文短词（FAQ/AI/API 等）门槛放低到 2 字符；正文仍按 minTextLength
  const minLen = container && isLinkLike(container) ? 2 : opts.minTextLength;
  if (text.length < minLen) return false;
  if (!LETTER_RE.test(text)) return false;
  if (isTargetLanguage(text, opts.targetLang)) return false;
  return true;
}

const LETTER_RE = /[A-Za-zÀ-ɏ぀-ヿ가-힣一-鿿]/;

/** 目标语言启发式：文本主体是否已是目标语言（避免对中文页翻中文等） */
export function isTargetLanguage(text: string, targetLang: string): boolean {
  const letters = text.replace(/[^A-Za-zÀ-ɏ぀-ヿ가-힣一-鿿]/g, "");
  if (!letters) return false;
  if (/^zh/i.test(targetLang)) {
    const cjk = (letters.match(/[一-鿿]/g) ?? []).length;
    return cjk / letters.length > 0.5;
  }
  if (/^ja/i.test(targetLang)) {
    const jp = (letters.match(/[぀-ヿ一-鿿]/g) ?? []).length;
    return jp / letters.length > 0.5;
  }
  if (/^ko/i.test(targetLang)) {
    const ko = (letters.match(/[가-힣]/g) ?? []).length;
    return ko / letters.length > 0.5;
  }
  const latin = (letters.match(/[A-Za-zÀ-ɏ]/g) ?? []).length;
  return latin / letters.length > 0.7;
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
