/**
 * 页面源语言检测（对照 read-frog webpage-context 的轻量版）：
 * 1. `<html lang>` 是最可靠的信号（站点显式声明）；
 * 2. 无声明时回退到已有的字符启发式（与 extractUnits 的 isTargetLanguage 同思路）；
 * 3. 用户「强制源语言」设置优先于一切（空串 = 自动）。
 * 检测结果随批量请求的上下文注入提示词，免费通道据此设置 sl/from 参数。
 */

/** 支持的源语言集合（ISO 639-1 为主，覆盖设置页可选目标语言 + 常见页面语言） */
export const KNOWN_SOURCE_LANGS = [
  "zh",
  "en",
  "ja",
  "ko",
  "de",
  "fr",
  "es",
  "pt",
  "ru",
  "ar",
  "it",
  "th",
  "vi",
] as const;

export type SourceLang = (typeof KNOWN_SOURCE_LANGS)[number] | "";

/** 语言别名归一：zh-CN/zh-Hans/zh-TW → zh；iw → he 等（html lang 常见写法收窄） */
export function normalizeLangTag(tag: string): string {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  if (primary === "iw" || primary === "ji") return "he";
  if (primary === "in") return "id";
  return primary;
}

/**
 * 从页面检测源语言（content 侧调用一次，结果随会话复用）：
 * - `<html lang>` 命中已知语言 → 用它；
 * - 否则按正文文本启发式猜（不精确，只用于提示词语境，宁缺毋滥返回 ""）。
 * forceSourceLang 非空时直接返回（用户显式指定优先）。
 */
export function detectPageSourceLang(forceSourceLang: string, sampleText: string): SourceLang {
  const forced = normalizeLangTag(forceSourceLang ?? "");
  if (forced && (KNOWN_SOURCE_LANGS as readonly string[]).includes(forced)) {
    return forced as SourceLang;
  }
  const htmlLang = normalizeLangTag(
    document.documentElement?.getAttribute("lang") ?? ""
  );
  if (htmlLang && (KNOWN_SOURCE_LANGS as readonly string[]).includes(htmlLang)) {
    return htmlLang as SourceLang;
  }
  return guessFromText(sampleText);
}

/** 文本启发式：按各语言特征字符的占比粗判。占比不明显时返回 ""（交给端点自动检测）。 */
export function guessFromText(text: string): SourceLang {
  const samples: Array<[SourceLang, RegExp]> = [
    ["ja", /[\u3040-\u309f\u30a0-\u30ff]/],
    ["ko", /[\uac00-\ud7af]/],
    ["zh", /[\u4e00-\u9fff]/],
    ["ru", /[\u0400-\u04ff]/],
    ["ar", /[\u0600-\u06ff]/],
    ["th", /[\u0e00-\u0e7f]/],
  ];
  for (const [lang, re] of samples) {
    const chars = text.match(new RegExp(re.source, "g"));
    // 特征字符达到一定密度才判定（假名/韩文几乎排他，可以直接判；汉字需先排除日文）
    const count = chars ? chars.length : 0;
    if (count === 0) continue;
    if (lang === "zh") {
      // 同时含假名 → 更可能是日文
      if (/[\u3040-\u30ff]/.test(text)) continue;
      if (count >= Math.max(5, text.length * 0.15)) return "zh";
      continue;
    }
    if (lang === "ja" || lang === "ko") return lang;
    if (count >= Math.max(5, text.length * 0.3)) return lang;
  }
  // 拉丁字母：区分常见西文需要词典级信息，字符集做不到，一律不猜
  return "";
}

/**
 * 把检测到的源语言并入批量请求上下文（仅提示词语境，帮助模型理解原文语言；
 * 目标语言不受影响）。srcLang 为空时不注入（行为与历史版本一致）。
 */
export function withSourceLangContext(contextText: string, srcLang: string): string {
  if (!srcLang) return contextText;
  const label: Record<string, string> = {
    zh: "中文",
    en: "英语",
    ja: "日语",
    ko: "韩语",
    de: "德语",
    fr: "法语",
    es: "西班牙语",
    pt: "葡萄牙语",
    ru: "俄语",
    ar: "阿拉伯语",
    it: "意大利语",
    th: "泰语",
    vi: "越南语",
  };
  const name = label[srcLang] ?? srcLang;
  const line = `原文语言：${name}（不要把原文语言误判为目标语言）`;
  return contextText ? `${contextText}\n${line}` : `\n\n${line}`;
}
