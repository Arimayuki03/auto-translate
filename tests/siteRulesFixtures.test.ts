// @vitest-environment jsdom
/**
 * 站点规则 × 真实站点 DOM 片段回归（read-frog 式 fixtures，tests/fixtures/*.html）：
 * 加载简化过的真实站点结构，断言「该译的译、该排的排」，防止内置规则或提取器回归。
 * 规则匹配按 fixtures 对应站点的 URL 解析（与生产路径一致：resolveSiteRules → ExtractOptions）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveSiteRules } from "../src/shared/siteRules";
import { extractUnits } from "../src/content/extractor";
import type { ExtractOptions } from "../content/extractor";

const here = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): string {
  return readFileSync(join(here, "fixtures", name), "utf-8");
}

/** 生产同构 options：内置规则按站点 URL 解析（用户规则为空、不禁用任何内置规则） */
function optsFor(url: string): ExtractOptions {
  const rule = resolveSiteRules(url, [], []);
  return {
    minTextLength: 2,
    blockMaxChars: 1200,
    targetLang: "zh-CN",
    excludeTags: rule.excludeTags,
    forceBlockTags: rule.forceBlockTags,
    excludeSelector: rule.excludeSelector,
  };
}

function setBody(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

function textsOf(root: HTMLElement, opts: ExtractOptions): string[] {
  return extractUnits(root, opts).map((u) => u.text);
}

let root: HTMLElement;
beforeEach(() => {
  root = document.body;
});

describe("fixture: github-repo.html", () => {
  const opts = () => optsFor("https://github.com/octocat/hello-world");

  beforeEach(() => {
    root = setBody(loadFixture("github-repo.html"));
  });

  it("README 正文正常提取", () => {
    const texts = textsOf(root, opts());
    expect(texts).toContain("hello-world");
    expect(texts).toContain("A tiny sample project used to verify GitHub layout extraction.");
    expect(texts).toContain("Clone the repository and run the setup script to install dependencies.");
  });

  it("仓库页头与文件列表被规则排除", () => {
    const texts = textsOf(root, opts()).join("\n");
    expect(texts).not.toContain("Folders and files");
    expect(texts).not.toContain("initial commit");
    expect(texts).not.toContain("docs: update readme");
    expect(texts).not.toContain("My first repository on GitHub!"); // #repository-container-header
  });

  it("diff 代码格与页头导航被排除", () => {
    const texts = textsOf(root, opts()).join("\n");
    expect(texts).not.toContain("const x = 1;");
    expect(texts).not.toContain("Features");
  });
});

describe("fixture: youtube-watch.html", () => {
  const opts = () => optsFor("https://www.youtube.com/watch?v=abc");

  beforeEach(() => {
    root = setBody(loadFixture("youtube-watch.html"));
  });

  it("视频标题与简介正常提取", () => {
    const texts = textsOf(root, opts());
    expect(texts).toContain("Understanding CSS Grid Layout");
    expect(texts.some((t) => t.includes("fundamentals of CSS Grid"))).toBe(true);
  });

  it("字幕条 / 控制条 / 侧栏导航 / 观看数被排除", () => {
    const texts = textsOf(root, opts()).join("\n");
    expect(texts).not.toContain("hello everyone and welcome back");
    expect(texts).not.toContain("12:34 / 25:00");
    expect(texts).not.toContain("Trending");
    expect(texts).not.toContain("subtitle overlay text");
    // 观看数（yt-formatted-string）不在排除列表 → 不应作为硬断言，只验证字幕相关被排
    expect(texts).not.toContain("Home");
  });
});

describe("fixture: hackernews-front.html", () => {
  const opts = () => optsFor("https://news.ycombinator.com/");

  beforeEach(() => {
    root = setBody(loadFixture("hackernews-front.html"));
  });

  it("标题与评论正文正常提取", () => {
    const texts = textsOf(root, opts());
    expect(texts).toContain(
      "Show HN: A tiny translation extension built with zero dependencies"
    );
    expect(texts.some((t) => t.includes("The whole discussion reminds me"))).toBe(true);
  });

  it("排名 / 分数 / 子信息行被排除", () => {
    const texts = textsOf(root, opts()).join("\n");
    expect(texts).not.toContain("342 points");
    expect(texts).not.toContain("128 points");
    expect(texts).not.toContain("5 hours ago");
  });
});

describe("fixture: stackoverflow-question.html", () => {
  const opts = () => optsFor("https://stackoverflow.com/questions/123/await");

  beforeEach(() => {
    root = setBody(loadFixture("stackoverflow-question.html"));
  });

  it("问题与回答正文正常提取", () => {
    const texts = textsOf(root, opts()).join("\n");
    expect(texts).toContain("How do I correctly await multiple promises");
    expect(texts).toContain("Promise.all preserves the order of the input array");
  });

  it("投票栏 / 签名 / 侧栏 / Ask Question 链接被排除", () => {
    const texts = textsOf(root, opts()).join("\n");
    expect(texts).not.toContain("42");
    expect(texts).not.toContain("community wiki");
    expect(texts).not.toContain("Questions");
    expect(texts).not.toContain("Ask Question");
    expect(texts).not.toContain("Add a comment");
  });
});
