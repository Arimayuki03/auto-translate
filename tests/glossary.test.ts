import { describe, expect, it } from "vitest";
import { tokenizeGlossary } from "../src/content/translate";

describe("tokenizeGlossary", () => {
  it("无术语时原样返回", () => {
    const { tokenized, restore } = tokenizeGlossary(["Hello world"], []);
    expect(tokenized).toEqual(["Hello world"]);
    expect(restore("Hello world")).toBe("Hello world");
  });

  it("术语被占位并在译文里还原", () => {
    const { tokenized, restore } = tokenizeGlossary(["OpenAI released GPT"], ["OpenAI", "GPT"]);
    expect(tokenized[0]).not.toContain("OpenAI");
    expect(restore(tokenized[0])).toBe("OpenAI released GPT");
  });

  it("长术语优先替换，避免子串误伤", () => {
    const { tokenized } = tokenizeGlossary(["Translate is a word"], ["Translate", "Translate is"]);
    expect(tokenized[0]).toContain("⟦0⟧"); // 更长的 "Translate is" 被保护
    expect(tokenized[0]).not.toContain("⟦1⟧"); // "Translate" 子串不再单独替换
  });
});
