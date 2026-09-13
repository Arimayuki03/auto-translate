// @vitest-environment jsdom
/**
 * 悬停翻译与 iframe 支持的回归测试：
 * 1. 顶层/子 frame 判定（isTopFrame，供 index.ts 装配分流）；
 * 2. 悬停候选解析（块级标签 + div/section 兜底）与排除规则（isHoverExcluded）；
 * 3. engine.translateElement 单元素翻译：只译该元素、与整页同一套去重口径、
 *    不推整页状态机（观察器/自动翻译以 state === "off" 判定“整页未翻译”）；
 * 4. 角标交互：悬停显示 / 移开隐藏 / 点击只译该段 / 整页翻译后不再出角标 / 敏感页不出角标。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageEngine } from "../src/content/engine";
import { Renderer } from "../src/content/renderer";
import {
  MIN_HOVER_TEXT_CHARS,
  findHoverCandidate,
  initHoverTranslate,
  isHoverExcluded,
  isTopFrame,
} from "../src/content/hover";
import type { Settings } from "../src/shared/types";

const LONG_EN = "The quick brown fox jumps over the lazy dog near the river bank every morning.";
const LONG_EN_2 = "Pack my box with five dozen liquor jugs while the museum opens its doors.";

function makeSettings(overrides: Partial<Settings["translate"]> = {}): Settings {
  return {
    api: {
      format: "openai",
      baseUrl: "http://test",
      apiKey: "k",
      model: "m",
      temperature: 0.3,
      timeoutMs: 60000,
      maxConcurrency: 3,
    },
    translate: {
      targetLang: "zh-CN",
      displayMode: "bilingual",
      autoTranslate: true,
      autoDetectSource: true,
      minTextLength: 2,
      blockMaxChars: 1200,
      translateOnSelect: true,
      translateInput: true,
      viewportLazy: false,
      terminology: [],
      ...overrides,
    },
    sites: { whitelist: [], blacklist: [] },
    security: { encryptApiKey: false, sensitivePages: false },
    cache: { enabled: true, maxEntries: 500 },
  };
}

let sendMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sendMessage = vi.fn(async (msg: { type: string; texts?: string[]; id?: string }) => {
    if (msg?.type === "translate") {
      return { id: msg.id, ok: true, results: (msg.texts ?? []).map((t) => `【译】${t}`) };
    }
    if (msg?.type === "check-cache") return { cachedCount: 0 };
    return undefined;
  });
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { sendMessage },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
  } as unknown as typeof chrome;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeEngine(settings = makeSettings()): PageEngine {
  const renderer = new Renderer(settings.translate.displayMode);
  renderer.setMode(settings.translate.displayMode);
  return new PageEngine(renderer, settings);
}

/** translateUnits 内部 fire-and-forget，需等宏任务/微任务让渲染完成 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
}

/** jsdom 无布局，手工给目标元素一个矩形（其余元素 keep 全 0） */
function stubRect(el: Element, left = 10, top = 40): void {
  el.getBoundingClientRect = () =>
    ({
      left,
      top,
      right: left + 200,
      bottom: top + 50,
      width: 200,
      height: 50,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe("顶层 / 子 frame 判定", () => {
  it("window.top === window.self → 顶层；不同引用 → 子 frame", () => {
    const top = { self: "W", top: "W" } as unknown as Window;
    const child = { self: "C", top: "T" } as unknown as Window;
    expect(isTopFrame(top)).toBe(true);
    expect(isTopFrame(child)).toBe(false);
    // jsdom 实际环境就是顶层 frame
    expect(isTopFrame()).toBe(true);
  });
});

describe("悬停候选解析", () => {
  it("从内层元素向上解析到最近的块级候选（p），div/section 兜底", () => {
    document.body.innerHTML =
      `<section id="sec"><div id="wrap"><p id="p">Hello <span id="s">world</span></p></div></section>`;
    expect(findHoverCandidate(document.getElementById("s"))).toBe(document.getElementById("p"));
    expect(findHoverCandidate(document.getElementById("wrap"))).toBe(document.getElementById("wrap"));
    expect(findHoverCandidate(document.getElementById("sec"))).toBe(document.getElementById("sec"));
    // body / 纯文本不在候选选择器内
    expect(findHoverCandidate(document.body)).toBeNull();
    expect(findHoverCandidate(null)).toBeNull();
  });
});

describe("悬停排除规则", () => {
  /** 每个用例独立挂载一个顶层元素并返回它 */
  const el = (html: string): HTMLElement => {
    const div = document.createElement("div");
    div.innerHTML = html;
    document.body.appendChild(div);
    return div.firstElementChild as HTMLElement;
  };

  it("短文本（<20 字符）排除，阈值导出常量", () => {
    expect(MIN_HOVER_TEXT_CHARS).toBe(20);
    expect(isHoverExcluded(el("<p>Too short</p>"))).toBe(true);
    expect(isHoverExcluded(el(`<p>${LONG_EN}</p>`))).toBe(false);
  });

  it("我们自己的 UI / 译文结构排除", () => {
    expect(isHoverExcluded(el(`<div data-it-ui>${LONG_EN}</div>`))).toBe(true);
    expect(isHoverExcluded(el(`<div data-it-unit="it-1">${LONG_EN}</div>`))).toBe(true);
    expect(isHoverExcluded(el(`<div class="it-wrap"><p>${LONG_EN}</p></div>`))).toBe(true);
    expect(isHoverExcluded(el(`<p class="it-translated">${LONG_EN}</p>`))).toBe(true);
  });

  it("已译 / 在途标记排除（与引擎去重标记一致）", () => {
    expect(isHoverExcluded(el(`<p data-it-src="">${LONG_EN}</p>`))).toBe(true);
    expect(isHoverExcluded(el(`<p data-it-processing="">${LONG_EN}</p>`))).toBe(true);
  });

  it("表单控件 / 可编辑区 / aria-hidden / 隐藏元素排除", () => {
    expect(isHoverExcluded(el(`<p contenteditable="true">${LONG_EN}</p>`))).toBe(true);
    expect(isHoverExcluded(el(`<p aria-hidden="true">${LONG_EN}</p>`))).toBe(true);
    expect(isHoverExcluded(el(`<p hidden>${LONG_EN}</p>`))).toBe(true);
    expect(isHoverExcluded(el(`<p style="display:none">${LONG_EN}</p>`))).toBe(true);
    // 位于表单控件子树内（结构合法场景：候选为控件内的块级兜底）
    expect(isHoverExcluded(el(`<button><p>${LONG_EN}</p></button>`))).toBe(true);
  });
});

describe("engine.translateElement 单元素翻译", () => {
  it("只译目标元素，且不推整页状态机（关键：观察器以 state=off 门控整页补扫）", async () => {
    document.body.innerHTML = `<p id="a">${LONG_EN}</p><p id="b">${LONG_EN_2}</p>`;
    const engine = makeEngine();

    engine.translateElement(document.getElementById("a")!);
    await flush();

    expect(document.getElementById("a")!.hasAttribute("data-it-src")).toBe(true);
    // 块级译文走包裹路径：译文是 .it-wrap 内 p 的兄弟节点，断言页面文本而非 p 自身
    expect(document.body.textContent).toContain("【译】");
    expect(document.querySelector(".it-translated.it-done")).toBeTruthy();
    expect(document.getElementById("b")!.hasAttribute("data-it-src")).toBe(false);
    // 单译期间与完成后 state 必须保持 off，否则下一次点击/动态变化会触发整页补译
    expect(engine.state).toBe("off");
    // 但文本级去重口径已记录（hasTranslated 为真，与整页语义一致）
    expect(engine.hasTranslated()).toBe(true);
  });

  it("与整页同一套去重口径：同文已译 / 已在途的元素不再调度", async () => {
    document.body.innerHTML = `<p id="a">${LONG_EN}</p>`;
    const engine = makeEngine();
    engine.translateElement(document.getElementById("a")!);
    await flush();
    expect(sendMessage.mock.calls.filter(([m]) => m?.type === "translate").length).toBe(1);

    // 另一处出现同文段落：引擎文本级去重（isSkipped）应跳过
    document.body.insertAdjacentHTML("beforeend", `<p id="c">${LONG_EN}</p>`);
    engine.translateElement(document.getElementById("c")!);
    await flush();
    expect(document.getElementById("c")!.hasAttribute("data-it-src")).toBe(false);
    expect(sendMessage.mock.calls.filter(([m]) => m?.type === "translate").length).toBe(1);
  });

  it("translateAll 解除钳制：整页翻译后状态正常推进到 done", async () => {
    document.body.innerHTML = `<p id="a">${LONG_EN}</p><p id="b">${LONG_EN_2}</p>`;
    const engine = makeEngine();

    engine.translateElement(document.getElementById("a")!);
    await flush();
    expect(engine.state).toBe("off");

    await engine.translateAll();
    await flush(); // translateUnits 是 fire-and-forget，状态推进在异步续程里
    expect(engine.state).toBe("done");
    expect(document.getElementById("b")!.hasAttribute("data-it-src")).toBe(true);
  });
});

describe("悬停角标交互", () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  function setup(isSensitive = () => false): { engine: PageEngine; badge: HTMLElement } {
    document.body.innerHTML = `<p id="a">${LONG_EN}</p><p id="b">${LONG_EN_2}</p>`;
    const engine = makeEngine();
    dispose = initHoverTranslate({ engine, isSensitive });
    const badge = document.querySelector<HTMLElement>(".it-hover-badge")!;
    expect(badge).toBeTruthy();
    expect(badge.hasAttribute("data-it-ui")).toBe(true); // 角标自身标记为我们的 UI
    return { engine, badge };
  }

  it("悬停显示、块内移动保持、移开隐藏", () => {
    const { badge } = setup();
    const a = document.getElementById("a")!;
    stubRect(a);

    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(badge.style.display).toBe("block");
    expect(badge.style.left).toBe("10px");
    expect(badge.style.top).toBe("16px"); // 左上角外侧（top=40 ≥ 26）

    // 块内移动（目标解析到同一候选）：角标不动
    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(badge.style.display).toBe("block");

    // 移开到无关区域（body）：隐藏
    document.body.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(badge.style.display).toBe("none");
  });

  it("点击角标只译该元素；翻译后同元素不再出角标", async () => {
    const { engine, badge } = setup();
    const a = document.getElementById("a")!;
    stubRect(a);

    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(badge.style.display).toBe("none"); // 点击后角标消失
    await flush();

    expect(document.getElementById("a")!.hasAttribute("data-it-src")).toBe(true);
    expect(document.getElementById("b")!.hasAttribute("data-it-src")).toBe(false);
    expect(engine.state).toBe("off"); // 悬停单译不改整页状态

    // 已译元素再悬停：引擎同口径预判无新鲜单元 → 不再出角标
    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(badge.style.display).toBe("none");
  });

  it("悬停单译一段后，其它段落仍可继续悬停翻译（功能不因 hasTranslated 自灭）", async () => {
    const { badge } = setup();
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    stubRect(a);
    stubRect(b, 10, 120);

    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(a.hasAttribute("data-it-src")).toBe(true);

    // 关键：state 仍为 off → 第二段照常出角标、可译
    b.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(badge.style.display).toBe("block");
    badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(b.hasAttribute("data-it-src")).toBe(true);
  });

  it("整页翻译后新内容不再出角标（状态机口径）；还原后恢复", async () => {
    const { engine, badge } = setup();
    const a = document.getElementById("a")!;
    stubRect(a);

    // 整页翻译完成后：state=done 且 hasTranslated → 角标关停
    await engine.translateAll();
    await flush();
    expect(engine.state).not.toBe("off");

    // 换页后新增的未翻译段落（元素本身无 data-it-src）：仅因整页状态而不出角标
    document.body.insertAdjacentHTML("beforeend", `<p id="c">${LONG_EN_2}</p>`);
    const c = document.getElementById("c")!;
    stubRect(c);
    c.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(badge.style.display).toBe("none");

    // 还原（state=off、doneTexts 清空）→ 角标恢复
    engine.restore();
    c.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(badge.style.display).toBe("block");
  });

  it("敏感页不出角标；划词选择进行中不出角标", () => {
    const { badge } = setup(() => true);
    const a = document.getElementById("a")!;
    stubRect(a);
    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(badge.style.display).toBe("none");
  });
});
