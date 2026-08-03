import { describe, expect, it } from "vitest";
import { splitBatch } from "../src/background/translate";

describe("splitBatch", () => {
  it("按行数匹配", () => {
    expect(splitBatch("a\nb\nc", 3)).toEqual(["a", "b", "c"]);
  });

  it("编号格式抽取", () => {
    expect(splitBatch("1. a\n2. b", 2)).toEqual(["a", "b"]);
    expect(splitBatch("1、甲\n2、乙", 2)).toEqual(["甲", "乙"]);
  });

  it("数量不匹配返回 null（走逐段降级）", () => {
    expect(splitBatch("a\nb", 3)).toBeNull();
  });
});
