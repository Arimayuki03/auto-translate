import { describe, expect, it } from "vitest";
import { BATCH_SEPARATOR, splitBatch } from "../src/background/translate";

const SEP = BATCH_SEPARATOR;

describe("splitBatch（哨兵分隔）", () => {
  it("按哨兵分段", () => {
    expect(splitBatch(`甲\n${SEP}\n乙\n${SEP}\n丙`, 3)).toEqual(["甲", "乙", "丙"]);
  });

  it("段内含换行也能正确归段（按行匹配做不到的）", () => {
    const out = `第一行\n第二行\n${SEP}\n第三行`;
    expect(splitBatch(out, 2)).toEqual(["第一行\n第二行", "第三行"]);
  });

  it("剥掉段首残留编号", () => {
    expect(splitBatch(`1. 甲\n${SEP}\n2、乙`, 2)).toEqual(["甲", "乙"]);
  });

  it("哨兵段数不符时回退行匹配", () => {
    // 只出现一个哨兵 → 段数 2，但期望 3 → 回退按行（行数也不符则为 null）
    expect(splitBatch(`甲\n${SEP}\n乙`, 3)).toBeNull();
  });
});

describe("splitBatch（行匹配兜底 / 兼容旧行为）", () => {
  it("按行数匹配", () => {
    expect(splitBatch("a\nb\nc", 3)).toEqual(["a", "b", "c"]);
  });

  it("编号格式抽取", () => {
    expect(splitBatch("1. a\n2. b", 2)).toEqual(["a", "b"]);
    expect(splitBatch("1、甲\n2、乙", 2)).toEqual(["甲", "乙"]);
  });

  it("部分行带编号时逐行剥离（回归：编号残留进译文）", () => {
    expect(splitBatch("1. a\nb", 2)).toEqual(["a", "b"]);
    expect(splitBatch("a\n2. b", 2)).toEqual(["a", "b"]);
  });

  it("数量不匹配返回 null（走逐段降级）", () => {
    expect(splitBatch("a\nb", 3)).toBeNull();
  });
});

describe("splitBatch（边界场景：换行 / 空段 / 编号 / Markdown / 代码）", () => {
  it("哨兵模式保留段内 Markdown 代码块（含多行与缩进）", () => {
    const code = "```js\nconst a = 1;\nif (a) {\n  return a;\n}\n```";
    const out = `# 标题\n${SEP}\n${code}`;
    expect(splitBatch(out, 2)).toEqual(["# 标题", code]);
  });

  it("哨兵模式保留段内行内代码与列表", () => {
    const out = `使用 \`npm install\` 安装\n${SEP}\n- 第一项\n- 第二项`;
    expect(splitBatch(out, 2)).toEqual(["使用 `npm install` 安装", "- 第一项\n- 第二项"]);
  });

  it("哨兵模式：译文中部含数字编号不被误剥（仅段首编号才剥）", () => {
    const out = `第 1 步：准备\n${SEP}\n2. 这是合法的第二段开头`;
    // 第一段中段数字保留；第二段段首 "2." 被剥（模型误编号的防御）
    expect(splitBatch(out, 2)).toEqual(["第 1 步：准备", "这是合法的第二段开头"]);
  });

  it("空段（模型漏译某段返回空）→ 段数不足返回 null，走逐段降级", () => {
    // 输入 3 段，模型只回了 2 段（中间漏了）→ 过滤空后只剩 2 ≠ 3 → null
    expect(splitBatch(`甲\n${SEP}\n${SEP}\n丙`, 3)).toBeNull();
  });

  it("行匹配兜底：空行被忽略，不影响段数判定", () => {
    expect(splitBatch("a\n\n\nb", 2)).toEqual(["a", "b"]);
  });

  it("行匹配兜底：段内含换行的多行内容无法按行还原 → null（应走哨兵或逐段）", () => {
    // 2 段但其中一段带换行 → 拆成 3 行 ≠ 2 → null（这正是哨兵协议存在的意义）
    expect(splitBatch("第一行\n第二行\n第三行", 2)).toBeNull();
  });
});
