// @vitest-environment jsdom
/** 语言检测增强：html lang 读取 / 强制源语言 / 文本启发式 / 上下文注入 */
import { afterEach, describe, expect, it } from "vitest";
import {
  detectPageSourceLang,
  guessFromText,
  normalizeLangTag,
  withSourceLangContext,
} from "../src/shared/langDetect";

afterEach(() => {
  document.documentElement.removeAttribute("lang");
});

describe("normalizeLangTag", () => {
  it("取主码并小写：zh-CN → zh、en-US → en", () => {
    expect(normalizeLangTag("zh-CN")).toBe("zh");
    expect(normalizeLangTag("en-US")).toBe("en");
  });
  it("别名归一：iw → he、in → id", () => {
    expect(normalizeLangTag("iw")).toBe("he");
    expect(normalizeLangTag("in")).toBe("id");
  });
  it("ISO 639-2 中文码归一：zho/chi → zh", () => {
    expect(normalizeLangTag("zho-TW")).toBe("zh");
    expect(normalizeLangTag("chi")).toBe("zh");
  });
});

describe("detectPageSourceLang", () => {
  it("用户强制源语言优先于 html lang 与启发式", () => {
    document.documentElement.setAttribute("lang", "en");
    expect(detectPageSourceLang("ja", "hello world")).toBe("ja");
  });

  it("html lang 命中已知语言时直接采用", () => {
    document.documentElement.setAttribute("lang", "de-DE");
    expect(detectPageSourceLang("", "hello")).toBe("de");
  });

  it("html lang 未知语言时回退文本启发式", () => {
    document.documentElement.setAttribute("lang", "xx-Unknown");
    expect(detectPageSourceLang("", "これは日本語のテキストです。")).toBe("ja");
  });

  it("html lang 的 zh 变体保留繁体标记：zh-TW/zh-Hant → zh-TW，zh-CN/zh-Hans → zh", () => {
    document.documentElement.setAttribute("lang", "zh-TW");
    expect(detectPageSourceLang("", "text")).toBe("zh-TW");
    document.documentElement.setAttribute("lang", "zh-Hant");
    expect(detectPageSourceLang("", "text")).toBe("zh-TW");
    document.documentElement.setAttribute("lang", "zh-CN");
    expect(detectPageSourceLang("", "text")).toBe("zh");
    document.documentElement.setAttribute("lang", "zh-Hans");
    expect(detectPageSourceLang("", "text")).toBe("zh");
  });

  it("ISO 639-2 写法同样走 html lang 快速路径：zho-TW → zh-TW、zho → zh", () => {
    document.documentElement.setAttribute("lang", "zho-TW");
    expect(detectPageSourceLang("", "text")).toBe("zh-TW");
    document.documentElement.setAttribute("lang", "zho-Hant");
    expect(detectPageSourceLang("", "text")).toBe("zh-TW");
    document.documentElement.setAttribute("lang", "zho");
    expect(detectPageSourceLang("", "text")).toBe("zh");
  });

  it("强制源语言同样保留 zh 繁体变体（导入设置可写入 zh-TW）", () => {
    expect(detectPageSourceLang("zh-TW", "text")).toBe("zh-TW");
    expect(detectPageSourceLang("zh-HK", "text")).toBe("zh-TW");
  });

  it("无任何信号时返回空串（交给端点自动检测）", () => {
    expect(detectPageSourceLang("", "plain latin text")).toBe("");
  });

  it("强制源语言不在支持列表时忽略强制值", () => {
    expect(detectPageSourceLang("klingon", "hello")).toBe("");
  });
});

describe("guessFromText", () => {
  it("假名 → ja；谚文 → ko", () => {
    expect(guessFromText("こんにちは世界、これはテストです。")).toBe("ja");
    expect(guessFromText("안녕하세요 이것은 텍스트입니다")).toBe("ko");
  });
  it("纯汉字 → zh；汉字与假名混排 → 非中文（日文优先）", () => {
    expect(guessFromText("这是中文文本，没有其他语言的特征字符。")).toBe("zh");
    expect(guessFromText("这是中文文本、但混with ひらがな")).not.toBe("zh");
  });
  it("西里尔/阿拉伯/泰文按特征字符判定", () => {
    expect(guessFromText("Это тестовый текст на русском языке.")).toBe("ru");
    expect(guessFromText("هذا نص تجريبي باللغة العربية على الشاشة")).toBe("ar");
    expect(guessFromText("นี่คือข้อความทดสอบภาษาไทยครับ")).toBe("th");
  });
  it("拉丁文本不猜具体语言（返回空串）", () => {
    expect(guessFromText("A plain english sentence here.")).toBe("");
  });
  it("短文本特征字符不足时不误判", () => {
    expect(guessFromText("中文")).toBe("");
  });
});

describe("withSourceLangContext", () => {
  it("空源语言：上下文原样返回", () => {
    expect(withSourceLangContext("CTX", "")).toBe("CTX");
  });
  it("有源语言：追加语言声明行", () => {
    const out = withSourceLangContext("CTX", "ja");
    expect(out).toContain("CTX");
    expect(out).toContain("原文语言：日语");
  });
  it("空上下文也能注入（生成带前导空行的语境段）", () => {
    expect(withSourceLangContext("", "en")).toContain("原文语言：英语");
  });

  it("zh-TW 注入繁体中文标签", () => {
    expect(withSourceLangContext("CTX", "zh-TW")).toContain("原文语言：中文（繁体）");
  });
});
