// @vitest-environment jsdom
/**
 * 巨型段落拆分（小而美 4）测试：
 * - splitBySentences 升级后的均衡聚簇、无边界硬上限强切、不产生空段、顺序稳定；
 * - 提取阶段超过 CHUNK_SPLIT_CHARS 的纯文本块被拆为多个子单元（chunk）进入管线；
 * - 行内控件（button）走 textOnly 原位替换，占位逻辑不受拆分影响。
 */
import { describe, expect, it } from "vitest";
import { CHUNK_SPLIT_CHARS, extractUnits, splitBySentences } from "../src/content/extractor";
import type { ExtractOptions } from "../src/content/extractor";

const OPTS: ExtractOptions = {
  minTextLength: 2,
  blockMaxChars: 1200,
  targetLang: "zh-CN",
};

/** 生成 n 句等长英文句（每句 15 字符，含句尾 "."），避免句长不均干扰均衡性断言 */
function uniformSentences(n: number): string {
  return Array.from({ length: n }, (_, i) => `Sentence ${String(i).padStart(2, "0")} ok.`).join(
    " "
  );
}

const strip = (s: string): string => s.replace(/\s+/g, "");

describe("CHUNK_SPLIT_CHARS", () => {
  it("阈值为 1200 且从 extractor 导出", () => {
    expect(CHUNK_SPLIT_CHARS).toBe(1200);
  });
});

describe("splitBySentences：均衡聚簇", () => {
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

  it("等长句子聚簇后各块贴近目标大小，而非「前满后尖」", () => {
    // 100 句 × 15 字符（总长含连接空格 1599），cap 300 → 目标块 ~267，实际 ~271
    const chunks = splitBySentences(uniformSentences(100), 300);
    expect(chunks.length).toBe(6);
    expect(chunks.every((c) => c.length >= 230 && c.length <= 300)).toBe(true);
  });

  it("切分不丢内容、顺序稳定（去空白后与原文一致）", () => {
    const text = uniformSentences(100);
    const chunks = splitBySentences(text, 300);
    expect(strip(chunks.join(""))).toBe(strip(text));
  });
});

describe("splitBySentences：硬上限强切", () => {
  it("无任何句子边界的超长文本按 maxChars 强切，内容无损", () => {
    const text = "a".repeat(3000);
    const chunks = splitBySentences(text, 1200);
    expect(chunks).toEqual(["a".repeat(1200), "a".repeat(1200), "a".repeat(600)]);
    expect(chunks.join("")).toBe(text);
  });

  it("单个超长句子（其余位置有边界）也会被强切到上限内", () => {
    const text = `${"b".repeat(2500)}. Tail sentence.`;
    const chunks = splitBySentences(text, 1200);
    expect(chunks.every((c) => c.length <= 1200)).toBe(true);
    expect(strip(chunks.join(""))).toBe(strip(text));
  });
});

describe("splitBySentences：边界质量", () => {
  it("连续句读/空白不产生空段", () => {
    const text = `${"。！？！ 。 ；  ".repeat(60)}END marker here.`;
    const chunks = splitBySentences(text, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true);
  });

  it("小数点/缩写中的英文句点不被切（后跟非空白）", () => {
    const text =
      "The value of pi is approximately 3.14159 in mathematics and it repeats forever. ".repeat(30);
    const chunks = splitBySentences(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      if (c.includes("3.14")) expect(c.includes("3.14159")).toBe(true);
    }
    expect(strip(chunks.join(""))).toBe(strip(text));
  });
});

describe("提取阶段拆分（extractUnits 集成）", () => {
  it("超过阈值的纯文本块被拆为多个子单元，各块 ≤ 上限且非空", () => {
    // ~1536 字符英文段落 > CHUNK_SPLIT_CHARS
    const text = `${"This is sentence number one for the giant paragraph test. ".repeat(25)}Final tail.`;
    document.body.innerHTML = `<p id="giant">${text}</p>`;
    const units = extractUnits(document.getElementById("giant")!, OPTS);
    expect(units).toHaveLength(1);
    const chunks = units[0].chunks;
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length > 0 && c.length <= CHUNK_SPLIT_CHARS)).toBe(true);
    expect(strip(chunks.join(""))).toBe(strip(text));
  });

  it("未超阈值的单元保持单 chunk，行为不变", () => {
    document.body.innerHTML = `<p id="short">A short paragraph stays intact.</p>`;
    const units = extractUnits(document.getElementById("short")!, OPTS);
    expect(units[0].chunks).toHaveLength(1);
    expect(units[0].chunks[0]).toBe("A short paragraph stays intact.");
  });

  it("行内控件（button）标记 textOnly，chunk 拆分不影响其原位替换路径", () => {
    // 控件不产生占位（reserve 直接跳过），拆分只在文本层发生
    document.body.innerHTML = `<button id="btn">Please confirm this extremely long action label text.</button>`;
    const units = extractUnits(document.getElementById("btn")!, OPTS);
    expect(units).toHaveLength(1);
    expect(units[0].textOnly).toBe(true);
  });
});
