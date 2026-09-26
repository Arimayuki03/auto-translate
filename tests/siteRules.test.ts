// @vitest-environment jsdom
/** 站点规则库：URL 模式匹配 / 规则合并解析 / 导入校验（jsdom 供选择器校验走真实解析） */
import { describe, expect, it } from "vitest";
import {
  normalizeUrlPattern,
  resolveSiteRules,
  sanitizeSiteRules,
  urlMatchesPattern,
} from "../src/shared/siteRules";
import type { SiteRule } from "../src/shared/siteRules";

function url(href: string): URL {
  return new URL(href);
}

function matches(href: string, pattern: string): boolean {
  return urlMatchesPattern(url(href), pattern);
}

describe("URL 模式匹配", () => {
  it("精确域名：本域及其子域命中，近似域不命中", () => {
    expect(matches("https://github.com/foo", "github.com")).toBe(true);
    expect(matches("https://gist.github.com/x", "github.com")).toBe(true);
    expect(matches("https://notgithub.com/x", "github.com")).toBe(false);
    expect(matches("https://github.com.evil.io/x", "github.com")).toBe(false);
  });

  it("*. 前缀通配：零或多级子域都命中（含主域）", () => {
    expect(matches("https://en.wikipedia.org/wiki/X", "*.wikipedia.org")).toBe(true);
    expect(matches("https://wikipedia.org/", "*.wikipedia.org")).toBe(true);
    expect(matches("https://a.b.wikipedia.org/", "*.wikipedia.org")).toBe(true);
    expect(matches("https://evil.wikipedia.org.evil.io/", "*.wikipedia.org")).toBe(false);
  });

  it("域内 * 与 TLD 通配：www.amazon.* 命中任意 TLD", () => {
    expect(matches("https://www.amazon.com/dp/1", "www.amazon.*")).toBe(true);
    expect(matches("https://www.amazon.co.uk/dp/1", "www.amazon.*")).toBe(true);
    expect(matches("https://ebay.com/", "www.amazon.*")).toBe(false);
  });

  it("* 匹配所有站点", () => {
    expect(matches("https://anything.example.org/a", "*")).toBe(true);
  });

  it("路径前缀语义：/docs 命中 /docs 与 /docs/x，不命中 /docsx", () => {
    expect(matches("https://example.com/docs", "example.com/docs")).toBe(true);
    expect(matches("https://example.com/docs/guide/1", "example.com/docs")).toBe(true);
    expect(matches("https://example.com/docsx", "example.com/docs")).toBe(false);
    expect(matches("https://example.com/", "example.com/docs")).toBe(false);
    // 尾部 * 等价于前缀匹配
    expect(matches("https://example.com/settings/profile", "example.com/settings*")).toBe(true);
  });

  it("excludeMatches 反向排除优先生效", () => {
    const rule: SiteRule = { matches: ["example.com"], excludeMatches: ["example.com/admin"] };
    const hit = (href: string) =>
      resolveSiteRules(href, [rule], ["math-render"]).matchedRuleIds.length > 0;
    expect(hit("https://example.com/news")).toBe(true);
    expect(hit("https://example.com/admin")).toBe(false);
  });

  it("带协议头 / 根路径的模式被规范化；非法模式不命中", () => {
    expect(normalizeUrlPattern("https://Example.com/")).toBe("example.com");
    expect(normalizeUrlPattern("http://example.com/docs")).toBe("example.com/docs");
    expect(normalizeUrlPattern("example.com:8080")).toBeNull(); // 端口不支持
    expect(normalizeUrlPattern("chrome://extensions")).toBeNull(); // 非 http(s) 协议
    expect(normalizeUrlPattern("  ")).toBeNull();
    expect(matches("https://example.com/x", "example.com:8080")).toBe(false);
  });

  it("中文 IDN 域名转 punycode 后可命中（与浏览器 hostname 归一口径一致）", () => {
    // 浏览器 new URL("https://豆瓣.com").hostname → xn--klyv21c.com，模式须同口径归一
    expect(normalizeUrlPattern("豆瓣.com")).toBe("xn--klyv21c.com");
    expect(normalizeUrlPattern("https://豆瓣.com/")).toBe("xn--klyv21c.com");
    // 通配符 + IDN 组合同样支持；非法 IDN（URL 解析失败）仍返回 null
    expect(normalizeUrlPattern("*.豆瓣.com")).toBe("*.xn--klyv21c.com");
    expect(normalizeUrlPattern("豆瓣.com:8080")).toBeNull(); // IDN 与端口组合：端口先拒绝
    expect(normalizeUrlPattern("bad host！.com")).toBeNull();
    // 端到端：punycode 页面 URL 命中中文写法的规则
    expect(matches("https://xn--klyv21c.com/", "豆瓣.com")).toBe(true);
    expect(matches("https://movie.douban.com/", "豆瓣.com")).toBe(false);
  });
});

describe("resolveSiteRules 合并解析", () => {
  it("全局内置规则（matches=*）在任意站点生效", () => {
    const r = resolveSiteRules("https://some-blog.example.org/post/1", [], []);
    expect(r.matchedRuleIds).toContain("math-render");
    expect(r.excludeSelector).toContain("katex");
  });

  it("禁用的内置规则不再生效", () => {
    const off = resolveSiteRules(
      "https://en.wikipedia.org/wiki/X",
      [],
      ["math-render", "wikipedia"]
    );
    expect(off.matchedRuleIds).not.toContain("math-render");
    expect(off.matchedRuleIds).not.toContain("wikipedia");
    expect(off.excludeSelector).toBeNull();
  });

  it("用户规则与命中的内置规则并集合并", () => {
    const users: SiteRule[] = [
      { matches: ["wikipedia.org"], excludeSelectors: [".my-sidebar"], excludeTags: ["my-icon"] },
    ];
    const r = resolveSiteRules("https://en.wikipedia.org/wiki/X", users, []);
    expect(r.matchedRuleIds).toContain("wikipedia");
    expect(r.excludeSelector).toContain("mw-editsection"); // 内置
    expect(r.excludeSelector).toContain("my-sidebar"); // 用户
    expect(r.excludeTags.has("MY-ICON")).toBe(true); // 标签大小写变体都收录
    expect(r.excludeTags.has("my-icon")).toBe(true);
  });

  it("无效选择器 / 非法标签被剔除，不污染合并结果", () => {
    const users: SiteRule[] = [
      {
        matches: ["example.com"],
        excludeSelectors: [".fine", "a[bad!!"],
        excludeTags: ["good-tag", "1bad", "WITH SPACE"],
        forceBlockTags: ["my-block"],
      },
    ];
    const r = resolveSiteRules("https://example.com/a", users, ["math-render"]);
    expect(r.excludeSelector).toBe(".fine");
    expect(r.excludeTags.has("GOOD-TAG")).toBe(true);
    expect(r.excludeTags.has("1BAD")).toBe(false);
    expect(r.forceBlockTags.has("MY-BLOCK")).toBe(true);
  });

  it("无命中时返回空规则", () => {
    const r = resolveSiteRules(
      "https://nothing-here.example.org/",
      [{ matches: ["example.com"], excludeSelectors: [".x"] }],
      ["math-render"]
    );
    expect(r.matchedRuleIds).toHaveLength(0);
    expect(r.excludeSelector).toBeNull();
    expect(r.excludeTags.size).toBe(0);
  });

  it("enabled=false 的用户规则被跳过", () => {
    const r = resolveSiteRules(
      "https://example.com/",
      [{ matches: ["example.com"], excludeSelectors: [".x"], enabled: false }],
      ["math-render"]
    );
    expect(r.excludeSelector).toBeNull();
  });
});

describe("sanitizeSiteRules 导入校验", () => {
  it("完整规则通过校验，字段原样保留", () => {
    const rules = sanitizeSiteRules([
      {
        matches: ["example.com", "docs.example.com"],
        excludeMatches: ["example.com/admin"],
        excludeSelectors: [".sidebar"],
        excludeTags: ["kbd"],
        forceBlockTags: ["my-block"],
        enabled: true,
      },
    ]);
    expect(rules).toHaveLength(1);
    expect(rules![0].matches).toEqual(["example.com", "docs.example.com"]);
    expect(rules![0].excludeSelectors).toEqual([".sidebar"]);
    expect(rules![0].forceBlockTags).toEqual(["my-block"]);
  });

  it("字符串形式的 matches 自动转数组", () => {
    const rules = sanitizeSiteRules([{ matches: "example.com", excludeSelectors: ".sidebar" }]);
    expect(rules![0].matches).toEqual(["example.com"]);
    expect(rules![0].excludeSelectors).toEqual([".sidebar"]);
  });

  it("缺 matches / 无任何动作字段的规则整条丢弃", () => {
    const rules = sanitizeSiteRules([
      { excludeSelectors: [".x"] }, // 无 matches
      { matches: ["example.com"] }, // 有 matches 但无动作字段
      null,
      "garbage",
      { matches: ["good.com"], excludeTags: ["kbd"] }, // 有效
    ]);
    expect(rules).toHaveLength(1);
    expect(rules![0].matches).toEqual(["good.com"]);
  });

  it("非法标签名被剔除；规则数封顶 100", () => {
    const rules = sanitizeSiteRules([{ matches: ["e.com"], excludeTags: ["ok", "1bad", "a b"] }]);
    expect(rules![0].excludeTags).toEqual(["ok"]);
    const many = sanitizeSiteRules(
      Array.from({ length: 150 }, (_, i) => ({ matches: [`h${i}.com`], excludeTags: ["x"] }))
    );
    expect(many).toHaveLength(100);
  });

  it("非数组输入返回 undefined（导入时回退默认值）", () => {
    expect(sanitizeSiteRules("nope")).toBeUndefined();
    expect(sanitizeSiteRules({ matches: [] })).toBeUndefined();
    expect(sanitizeSiteRules(undefined)).toBeUndefined();
  });
});
