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

/** 不参与翻译的标签（文本在这些标签内一律跳过） */
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
    const container = nearestBlockContainer(t);
    if (container === document.body) continue;
    let list = grouped.get(container);
    if (!list) grouped.set(container, (list = []));
    list.push(t);
  }

  const units: TranslationUnit[] = [];
  for (const [container, nodes] of grouped) {
    const text = joinTextNodes(nodes);
    if (!shouldTranslate(text, opts)) continue;
    units.push({
      id: `it-${++seq}`,
      container,
      text,
      chunks: splitBySentences(text, opts.blockMaxChars),
    });
  }
  return units;
}

/** 文本节点是否位于排除区域（标签 / 属性 / 可编辑） */
function isExcluded(node: Text): boolean {
  for (
    let el: HTMLElement | null = node.parentElement;
    el && el !== document.body;
    el = el.parentElement
  ) {
    if (EXCLUDED_TAGS.has(el.tagName)) return true;
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

/** 单元是否值得翻译：够长、含字母、且不是目标语言 */
function shouldTranslate(text: string, opts: ExtractOptions): boolean {
  if (text.length < opts.minTextLength) return false;
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

/** 超长文本按句子切分，每块控制在 maxChars 以内 */
function splitBySentences(text: string, maxChars: number): string[] {
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
