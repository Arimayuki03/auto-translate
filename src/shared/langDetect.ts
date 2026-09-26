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

export type SourceLang = (typeof KNOWN_SOURCE_LANGS)[number] | "zh-TW" | "";

/** 语言别名归一：zh-CN/zh-Hans/zh-TW → zh；ISO 639-2 中文码 zho/chi → zh；iw → he 等
 *  （html lang 常见写法收窄，否则这些标签会整体跳过 html-lang 快速路径） */
export function normalizeLangTag(tag: string): string {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  if (primary === "iw" || primary === "ji") return "he";
  if (primary === "in") return "id";
  if (primary === "zho" || primary === "chi") return "zh";
  return primary;
}

/**
 * 从页面检测源语言（content 侧调用一次，结果随会话复用）：
 * - `<html lang>` 命中已知语言 → 用它（zh 系按原始标签保留繁体变体，见 refineZhVariant）；
 * - 否则按正文文本启发式猜（不精确，只用于提示词语境，宁缺毋滥返回 ""）。
 * forceSourceLang 非空时直接返回（用户显式指定优先）。
 */
export function detectPageSourceLang(forceSourceLang: string, sampleText: string): SourceLang {
  const forcedRaw = (forceSourceLang ?? "").trim();
  const forced = normalizeLangTag(forcedRaw);
  if (forced && (KNOWN_SOURCE_LANGS as readonly string[]).includes(forced)) {
    return refineZhVariant(forcedRaw, forced);
  }
  const htmlLangRaw = document.documentElement?.getAttribute("lang") ?? "";
  const htmlLang = normalizeLangTag(htmlLangRaw);
  if (htmlLang && (KNOWN_SOURCE_LANGS as readonly string[]).includes(htmlLang)) {
    return refineZhVariant(htmlLangRaw.trim(), htmlLang);
  }
  return guessFromText(sampleText);
}

/** zh 系保留繁体变体（zh-TW/zh-HK/zh-MO/zh-Hant → zh-TW；ISO 639-2 写法 zho-TW 同样识别）：
 *  Microsoft 端点要求具体的 zh-Hans/zh-Hant（不认裸 zh），繁中页传 zh-Hans 会按简体处理；
 *  简体/未知变体回落主码 zh，由各端点自行归一（Google → zh-CN，Microsoft → zh-Hans）。 */
function refineZhVariant(rawTag: string, primary: string): SourceLang {
  if (primary === "zh" && /^zho?[-_]?(tw|hk|mo|hant)\b/i.test(rawTag)) return "zh-TW";
  return primary as SourceLang;
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
  const countOf = (re: RegExp): number => (text.match(new RegExp(re.source, "g")) ?? []).length;
  for (const [lang, re] of samples) {
    const count = countOf(re);
    if (count === 0) continue;
    if (lang === "zh" || lang === "ja" || lang === "ko") {
      // 密度门槛（zh/ja/ko 同式 count >= max(5, len*0.15)）：假名/谚文/汉字并非完全
      // 排他（中文页会夹带「フィギュア」等假名外来词），特征字符绝对数量太少时
      // 不够下结论，continue 落到后续判定（zh 或返回 ""）
      if (count < Math.max(5, text.length * 0.15)) continue;
      if (lang === "ja") {
        // 假名/汉字占比：真日文页假名/汉字比通常 >10%（助词及送假名密集），
        // 中文页夹带的假名几乎总远低于此 → 占比过低视为中文夹带外来词，落 zh 分支
        const kanji = countOf(/[\u4e00-\u9fff]/);
        if (kanji > 0 && count < kanji * 0.1) continue;
        return "ja";
      }
      if (lang === "ko") return "ko"; // 谚文与汉字/假名近乎互斥，过密度门槛即可判
      // zh：假名相对密度 >= 15%（同 ja 密度式，不含绝对下限——那是「确信日文」
      // 的条件，这里只排除「假名多到不像纯中文」的短混排文本，宁缺毋滥返回 ""）。
      // 能落到这里的假名，都是未过 ja 严格门槛的夹带外来词，不再整体回滚中文判定
      if (countOf(/[\u3040-\u309f\u30a0-\u30ff]/) >= text.length * 0.15) continue;
      return "zh";
    }
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
    "zh-TW": "中文（繁体）",
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
