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

  it("长术语优先替换，短术语不得抢先拆碎长术语", () => {
    // 断言必须是**替换后的实际文本**，不能断言 ⟦n⟧ 的下标：
    // 下标按排序后的 terms 数组分配，把排序反转成短术语优先，⟦0⟧ 只是换了含义，
    // `toContain("⟦0⟧")` / `not.toContain("⟦1⟧")` 会逐字继续成立（此用例曾因此空转）。
    const { tokenized, restore } = tokenizeGlossary(["AI Agent works"], ["AI", "AI Agent"]);
    // 整个 "AI Agent" 被保护成单个 token；短术语抢跑会留下裸的 " Agent"
    expect(tokenized[0]).toBe("⟦0⟧ works");
    expect(restore(tokenized[0])).toBe("AI Agent works");
  });
});
