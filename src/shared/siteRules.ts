/**
 * 站点规则库（对照 read-frog site-rules 的轻量子集）：
 * - excludeSelectors：命中元素及其子树不翻译（GitHub 文件列表 / YouTube 字幕条等「排除区」）；
 * - excludeTags：这些标签内的文本一律不翻译（并入内置排除标签，如自定义图标组件）；
 * - forceBlockTags：这些标签强制按块级翻译单元处理（每个自成单元，适合页面自定义组件）。
 * 匹配命中的所有规则按「并集」合并：用户规则只能加码；想放开某条内置规则的排除区，
 * 请在设置页把它禁用（disabledRuleIds）。
 */

/** 单条站点规则（内置规则与用户自定义规则共用结构） */
export interface SiteRule {
  /** 规则 id：内置规则用于「禁用」标记；用户规则可省略 */
  id?: string;
  /** 展示名（设置页勾选列表用） */
  name?: string;
  /** URL 匹配模式：host 或 host/路径前缀；"*" = 全站；支持 *.example.com、www.amazon.* */
  matches: string[];
  /** 反向排除：URL 命中这些模式时本规则不生效（如 github.com/settings） */
  excludeMatches?: string[];
  /** 命中元素及其子树不翻译的 CSS 选择器 */
  excludeSelectors?: string[];
  /** 不翻译的标签名（如 kbd、my-icon） */
  excludeTags?: string[];
  /** 强制按块级翻译单元处理的标签名 */
  forceBlockTags?: string[];
  /** 用户规则的启用开关；内置规则的禁用走 disabledRuleIds */
  enabled?: boolean;
}

/** 解析结果：本页所有命中规则合并后的有效规则（热路径直接消费，选择器已合并校验） */
export interface ResolvedSiteRule {
  /** 合并后的排除区选择器（逗号连接，可直接用于 element.matches / closest）；null = 无 */
  excludeSelector: string | null;
  /** 不翻译的标签（同标签的大小写变体都已收录，Set.has 用 el.tagName 直查） */
  excludeTags: ReadonlySet<string>;
  /** 强制块级的标签（同上） */
  forceBlockTags: ReadonlySet<string>;
  /** 命中的规则 id（诊断用） */
  matchedRuleIds: string[];
}

export const EMPTY_SITE_RULE: ResolvedSiteRule = {
  excludeSelector: null,
  excludeTags: new Set<string>(),
  forceBlockTags: new Set<string>(),
  matchedRuleIds: [],
};

/**
 * 内置站点规则库：适配常见站点的「排除区」（导航/按钮/字幕/代码区等机器化文本，
 * 翻译它们没有收益还破坏布局）。matches 用 host 或 host/路径前缀；选取原则是
 * 「每个站点只排除明确无翻译价值的区域」，宁缺毋滥——个别条目不合意可在设置页禁用。
 */
export const BUILT_IN_RULES: readonly SiteRule[] = [
  {
    id: "math-render",
    name: "全局 · 数学公式渲染区",
    matches: ["*"],
    excludeSelectors: [
      "span.katex",
      ".katex-display",
      ".MathJax",
      ".MathJax_Display",
      ".MathJax_Preview",
      "math-renderer",
      ".mwe-math-element",
      ".mathjax-block",
      ".ltx_Math",
      "mjx-container",
    ],
  },
  {
    id: "wikipedia",
    name: "Wikipedia / Wiktionary",
    matches: ["*.wikipedia.org", "*.wiktionary.org"],
    excludeSelectors: [
      ".mw-editsection",
      ".mw-cite-backlink",
      "#p-lang-btn",
      ".vector-header",
      "#right-navigation",
      "#p-associated-pages",
      ".lazy-image-placeholder",
      ".navbox",
      ".vertical-navbox",
      "sup.reference",
    ],
  },
  {
    id: "github",
    name: "GitHub / Gist",
    matches: ["github.com", "gist.github.com"],
    excludeSelectors: [
      "header",
      "#repository-container-header",
      "a[data-hovercard-type]",
      "a.anchor",
      "table.diff-table",
      ".file-navigation",
      "div.Box-header",
      "[data-testid='breadcrumbs']",
      "[data-ga-click*='Star']",
      "[aria-labelledby='folders-and-files']",
      "td.blob-code",
      "td.blob-num",
      ".react-code-lines",
      ".js-repos-container .markdown-title",
    ],
  },
  {
    id: "discord",
    name: "Discord",
    matches: ["discord.com"],
    excludeSelectors: [
      "[id^='message-username']",
      "[class*='username_']",
      "span[class*='-timestamp']",
      "[class*='-repliedMessage']",
      "[class*='-subtitleContainer']",
      "[class*='-formWithLoadedChatInput']",
    ],
  },
  {
    id: "reddit",
    name: "Reddit",
    matches: ["www.reddit.com", "old.reddit.com"],
    excludeSelectors: [
      "shreddit-comment-action-row",
      "faceplate-hovercard",
      ".text-neutral-content-weak",
      ".rank",
      ".score",
      ".midcol",
      ".entry .buttons",
    ],
  },
  {
    id: "youtube",
    name: "YouTube",
    matches: ["www.youtube.com", "m.youtube.com", "music.youtube.com"],
    excludeSelectors: [
      ".ytp-caption-window-container",
      ".captions-text",
      ".imt-caption-container",
      "ytd-live-chat-frame",
      "ytd-button-renderer",
      "yt-button-shape",
      "#guide-inner-content",
      "#masthead-container",
      ".ytp-chrome-bottom",
      ".ytp-chrome-controls",
    ],
  },
  {
    id: "hackernews",
    name: "Hacker News",
    matches: ["news.ycombinator.com"],
    excludeSelectors: [".rank", ".subtext", ".comhead", ".reply", ".score", ".togg"],
  },
  {
    id: "stackoverflow",
    name: "Stack Overflow / Stack Exchange",
    matches: [
      "stackoverflow.com",
      "*.stackexchange.com",
      "superuser.com",
      "askubuntu.com",
      "serverfault.com",
    ],
    excludeSelectors: [
      ".votecell",
      "#left-sidebar",
      "#footer",
      "div[id^='comments-link-']",
      "a.comment-user",
      "span.comment-date",
      ".js-post-signature",
      "div.s-prose.js-post-body + div",
      "a[href='/questions/ask']",
    ],
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    matches: ["chatgpt.com", "chat.openai.com"],
    excludeSelectors: [".ProseMirror", "nav"],
  },
  {
    id: "medium",
    name: "Medium",
    matches: ["medium.com", "*.medium.com"],
    excludeSelectors: ["[aria-label='Post Preview Reading Time']", ".speechify-ignore"],
  },
  {
    id: "notion",
    name: "Notion",
    matches: ["notion.site", "*.notion.site"],
    excludeSelectors: [".notion-code-block"],
  },
  {
    id: "substack",
    name: "Substack",
    matches: ["*.substack.com"],
    excludeSelectors: [
      ".subscription-widget-wrap",
      ".publication-footer",
      ".subscribe-footer",
      "[data-testid='navbar']",
      ".captioned-button-wrap",
    ],
  },
];

// ===== URL 模式匹配 =====

/**
 * 规范化 URL 模式：小写 host + 可选路径前缀。协议头仅支持 http/https/*（我们的页面
 * 本就只跑在 http(s) 上，协议一律忽略）；带端口的 host 与空 host 不支持，返回 null。
 */
export function normalizeUrlPattern(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  let rest = trimmed;
  const schemeMatch = rest.match(/^([a-z][a-z0-9+.-]*|\*):\/\//);
  if (schemeMatch) {
    const scheme = schemeMatch[1];
    if (scheme !== "*" && scheme !== "http" && scheme !== "https") return null;
    rest = rest.slice(schemeMatch[0].length);
  }
  const slash = rest.indexOf("/");
  const host = slash === -1 ? rest : rest.slice(0, slash);
  let path = slash === -1 ? "" : rest.slice(slash);
  if (!host || host.includes(":") || !/^[a-z0-9.*-]+$/.test(host)) return null;
  if (path === "/") path = ""; // host 级模式，任意路径
  return `${host}${path}`;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** host 匹配：精确 / 子域后缀；带 * 时走正则（开头的 *. 匹配零或多级子域，含主域） */
function hostMatches(host: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) {
    return host === pattern || host.endsWith("." + pattern);
  }
  let source = pattern.split("*").map(escapeRe).join("[a-z0-9.-]*");
  if (source.startsWith("[a-z0-9.-]*\\.")) {
    source = `(?:[^.]+\\.)*${source.slice("[a-z0-9.-]*\\.".length)}`;
  }
  try {
    return new RegExp(`^${source}$`, "i").test(host);
  } catch {
    return false;
  }
}

/**
 * 路径匹配（前缀语义，比 match-pattern 的默认全等更符合站点规则直觉）：
 * /docs 命中 /docs 与 /docs/*，不命中 /docsx；尾部 * 等价于前缀匹配。
 */
function pathMatches(pathname: string, pattern: string): boolean {
  if (pattern.endsWith("*")) pattern = pattern.slice(0, -1);
  if (!pattern || pattern === "/") return true;
  return (
    pathname === pattern || pathname.startsWith(pattern.endsWith("/") ? pattern : pattern + "/")
  );
}

/** 单条模式是否命中 URL（非法模式一律不命中） */
export function urlMatchesPattern(url: URL, rawPattern: string): boolean {
  const normalized = normalizeUrlPattern(rawPattern);
  if (!normalized) return false;
  const slash = normalized.indexOf("/");
  const hostPattern = slash === -1 ? normalized : normalized.slice(0, slash);
  const pathPattern = slash === -1 ? "" : normalized.slice(slash);
  if (!hostMatches(url.hostname.toLowerCase(), hostPattern)) return false;
  return !pathPattern || pathMatches(url.pathname, pathPattern);
}

/** 规则是否命中 URL：matches 至少命中一个，且不落在 excludeMatches 里 */
function urlMatchesRule(url: URL, rule: SiteRule): boolean {
  const matches = Array.isArray(rule.matches)
    ? rule.matches
    : typeof rule.matches === "string"
      ? [rule.matches]
      : [];
  if (!matches.some((p) => urlMatchesPattern(url, p))) return false;
  return !(rule.excludeMatches ?? []).some((p) => urlMatchesPattern(url, p));
}

// ===== 选择器 / 标签校验 =====

const selectorValidity = new Map<string, boolean>();

/** 逐条校验选择器：一条坏选择器会让整个合并串在 matches() 时抛错，必须单独剔除 */
function isValidSelector(selector: string): boolean {
  let valid = selectorValidity.get(selector);
  if (valid === undefined) {
    try {
      if (typeof document !== "undefined") {
        document.createDocumentFragment().querySelector(selector);
      }
      valid = true;
    } catch {
      valid = false;
    }
    selectorValidity.set(selector, valid);
  }
  return valid;
}

const TAG_NAME_RE = /^[a-z][a-z0-9-]*$/i;

/** 标签名校验 + 大小写归一：HTML 元素 tagName 为大写、SVG/MathML 保形，三种形态都收录 */
function collectTags(entries: unknown, out: Set<string>): void {
  const arr = Array.isArray(entries) ? entries : typeof entries === "string" ? [entries] : [];
  for (const entry of arr) {
    if (typeof entry !== "string") continue;
    const tag = entry.trim();
    if (!TAG_NAME_RE.test(tag)) continue;
    out.add(tag);
    out.add(tag.toUpperCase());
    out.add(tag.toLowerCase());
  }
}

/**
 * 合并解析：内置规则（未被禁用）+ 用户规则（enabled !== false）里所有命中 url 的规则
 * 取并集。多规则同时命中时选择器/标签互相叠加；本函数在页面装配时调用一次，热路径只消费结果。
 */
export function resolveSiteRules(
  url: string,
  userRules: readonly SiteRule[],
  disabledBuiltInIds: readonly string[] = []
): ResolvedSiteRule {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return EMPTY_SITE_RULE;
  }
  const disabled = new Set(disabledBuiltInIds);
  const candidates: SiteRule[] = [
    ...BUILT_IN_RULES.filter((r) => !r.id || !disabled.has(r.id)),
    // 无 id 的用户规则合成诊断 id，保证 matchedRuleIds 能反映真实命中
    ...userRules
      .filter((r) => r.enabled !== false)
      .map((r, i) => (r.id ? r : { ...r, id: `user-${i}` })),
  ];
  const matched = candidates.filter((r) => urlMatchesRule(parsed, r));
  if (matched.length === 0) return EMPTY_SITE_RULE;

  const selectors = new Set<string>();
  const excludeTags = new Set<string>();
  const forceBlockTags = new Set<string>();
  for (const rule of matched) {
    const selArr = Array.isArray(rule.excludeSelectors)
      ? rule.excludeSelectors
      : typeof rule.excludeSelectors === "string"
        ? [rule.excludeSelectors]
        : [];
    for (const sel of selArr) {
      const t = typeof sel === "string" ? sel.trim() : "";
      if (t && isValidSelector(t)) selectors.add(t);
    }
    collectTags(rule.excludeTags, excludeTags);
    collectTags(rule.forceBlockTags, forceBlockTags);
  }
  return {
    excludeSelector: selectors.size > 0 ? [...selectors].join(",") : null,
    excludeTags,
    forceBlockTags,
    matchedRuleIds: matched.map((r) => r.id ?? "").filter(Boolean),
  };
}

// ===== 导入校验 =====

const MAX_RULES = 100;

/**
 * 用户自定义规则的逐字段校验（导入 / 设置页共用）：类型不符的字段剔除，
 * matches 为空（永不生效）或没有任何动作字段的整条丢弃，规则数封顶 100。
 * 返回 undefined 表示整体不是数组（导入时回退默认值）。
 */
export function sanitizeSiteRules(input: unknown): SiteRule[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const rules: SiteRule[] = [];
  for (const raw of input.slice(0, MAX_RULES)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const obj = raw as Record<string, unknown>;
    const strArrField = (v: unknown): string[] | undefined => {
      if (typeof v === "string") return [v];
      return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined;
    };
    const matches = (strArrField(obj.matches) ?? [])
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (matches.length === 0) continue;
    const rule: SiteRule = { matches };
    if (typeof obj.id === "string" && obj.id.trim()) rule.id = obj.id.trim();
    if (typeof obj.name === "string" && obj.name.trim()) rule.name = obj.name.trim();
    const excludeMatches = strArrField(obj.excludeMatches);
    if (excludeMatches?.length) rule.excludeMatches = excludeMatches;
    const excludeSelectors = strArrField(obj.excludeSelectors);
    if (excludeSelectors?.length) rule.excludeSelectors = excludeSelectors;
    const tagField = (v: unknown): string[] | undefined =>
      strArrField(v)
        ?.filter((t) => TAG_NAME_RE.test(t.trim()))
        .map((t) => t.trim());
    const excludeTags = tagField(obj.excludeTags);
    if (excludeTags?.length) rule.excludeTags = excludeTags;
    const forceBlockTags = tagField(obj.forceBlockTags);
    if (forceBlockTags?.length) rule.forceBlockTags = forceBlockTags;
    if (typeof obj.enabled === "boolean") rule.enabled = obj.enabled;
    if (rule.excludeSelectors || rule.excludeTags || rule.forceBlockTags) rules.push(rule);
  }
  return rules;
}
