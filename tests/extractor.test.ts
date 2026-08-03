import { describe, expect, it } from "vitest";
import { isTargetLanguage, splitBySentences } from "../src/content/extractor";

describe("splitBySentences", () => {
  it("短文本整块返回", () => {
    expect(splitBySentences("Hello world", 1200)).toEqual(["Hello world"]);
  });

  it("超长文本按句子切分且每块不超限", () => {
    const text = "First sentence. Second sentence. Third sentence. Fourth sentence.";
    const chunks = splitBySentences(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(" ")).toContain("First sentence");
    expect(chunks.every((c) => c.length <= 40)).toBe(true);
  });
});

describe("isTargetLanguage", () => {
  it("中文文本对 zh 目标返回 true", () => {
    expect(isTargetLanguage("这是一段中文测试文字", "zh-CN")).toBe(true);
  });

  it("英文文本对 zh 目标返回 false", () => {
    expect(isTargetLanguage("This is an English sentence", "zh-CN")).toBe(false);
  });

  it("日文文本对 ja 目标返回 true", () => {
    expect(isTargetLanguage("これは日本語のテストです", "ja")).toBe(true);
  });

  it("韩文文本对 ko 目标返回 true", () => {
    expect(isTargetLanguage("이것은 한국어 테스트입니다", "ko")).toBe(true);
  });
});
