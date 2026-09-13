// @vitest-environment jsdom
/**
 * 译文样式主题回归测试：
 * - body 主题类挂载/切换/非法值回退；
 * - 自定义 CSS 注入 <style data-it-ui>、剥掉 </style> 逃逸序列、限长、空值移除。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { applyTranslationStyle } from "../src/content/style";
import type { TranslationStyle } from "../src/shared/types";

beforeEach(() => {
  document.body.className = "";
  document.getElementById("it-custom-style")?.remove();
});

describe("applyTranslationStyle", () => {
  it("默认挂 gray 主题类", () => {
    applyTranslationStyle(undefined, "");
    expect(document.body.classList.contains("it-style-gray")).toBe(true);
  });

  it("切换主题时替换旧主题类（不残留）", () => {
    applyTranslationStyle("outline", "");
    expect(document.body.classList.contains("it-style-outline")).toBe(true);
    applyTranslationStyle("blur", "");
    expect(document.body.classList.contains("it-style-blur")).toBe(true);
    expect(document.body.classList.contains("it-style-outline")).toBe(false);
    expect(document.body.classList.length).toBe(1);
  });

  it("非法主题值回退 gray", () => {
    applyTranslationStyle("weird" as TranslationStyle, "");
    expect(document.body.classList.contains("it-style-gray")).toBe(true);
  });

  it("自定义 CSS 注入 style[data-it-ui]#it-custom-style", () => {
    applyTranslationStyle("gray", ".it-translated { opacity: 0.85; }");
    const el = document.getElementById("it-custom-style");
    expect(el).not.toBeNull();
    expect(el?.getAttribute("data-it-ui")).toBe("");
    expect(el?.textContent).toBe(".it-translated { opacity: 0.85; }");
  });

  it("自定义 CSS 剥掉 </style> 逃逸序列（大小写不敏感，防提前闭合 style 节点）", () => {
    applyTranslationStyle("gray", '.a{}</STYLE>x</style>y</StYlE>');
    const el = document.getElementById("it-custom-style");
    expect(el?.textContent).toBe(".a{}>x>y>"); // 剥掉 </style 序列，残留的 > 为惰性文本
  });

  it("自定义 CSS 超长截断到 8000 字符", () => {
    applyTranslationStyle("gray", "a".repeat(9000));
    expect(document.getElementById("it-custom-style")?.textContent?.length).toBe(8000);
  });

  it("空自定义 CSS 移除已注入的 style 节点（幂等可重复调用）", () => {
    applyTranslationStyle("gray", ".a{}");
    applyTranslationStyle("gray", "");
    expect(document.getElementById("it-custom-style")).toBeNull();
    applyTranslationStyle("gray", "");
    expect(document.querySelectorAll("#it-custom-style")).toHaveLength(0);
  });
});
