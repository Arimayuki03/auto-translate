// @vitest-environment jsdom
/**
 * 悬停翻译与 iframe 支持的回归测试：
 * 1. 顶层/子 frame 判定（isTopFrame，供 index.ts 装配分流）；
 * 2. 悬停候选解析（块级标签 + div/section 兜底）与排除规则（isHoverExcluded）；
 * 3. caret 命中测试三态（判定区域重写的核心）：文字上=hit、空白/非文本=blank、无 API=unsupported；
 * 4. engine.translateElement 单元素翻译：只译该元素、与整页同一套去重口径、
 *    不推整页状态机（观察器/自动翻译以 state === "off" 判定"整页未翻译"）；
 * 5. 角标交互：停留达标显示 / 不足不显示（杜绝快速划动满屏弹）/ 移开隐藏 / 点击只译该段 /
 *    整页翻译后不再出角标 / 敏感页不出角标；
 * 6. 角标可点性：移出候选延迟隐藏（300ms 内悬停角标/回到候选即取消）；
 * 7. 角标双模式：译后再悬停出「还原」，点击只还原该段（引擎/渲染器单元素还原 + 去重同步清理）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, uninstallChromeMock } from "./helpers/chromeMock";
import { PageEngine } from "../src/content/engine";
import { Renderer } from "../src/content/renderer";
import { t } from "../src/shared/i18n";
import {
  HOVER_SHOW_DELAY_MS,
  MIN_HOVER_TEXT_CHARS,
  caretHitAt,
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
    enabled: true,
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
    tts: { enabled: true, voice: "", rate: 0 },
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
  installChromeMock({ extra: { runtime: { sendMessage } } });
});

afterEach(() => {
  vi.useRealTimers();
  uninstallChromeMock();
  vi.restoreAllMocks();
  const doc = document as { caretRangeFromPoint?: unknown };
  delete doc.caretRangeFromPoint;
});

function makeEngine(settings = makeSettings()): PageEngine {
  const renderer = new Renderer(settings.translate.displayMode);
  renderer.setMode(settings.translate.displayMode);
  return new PageEngine(renderer, settings);
}

/** 假定时器环境下推进宏/微任务，让引擎的 fire-and-forget 渲染链落地 */
async function settle(ms = 300): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** 悬停并停留到角标弹出的门槛 */
function hoverOver(el: Element): void {
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS);
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

describe("caret 命中测试（判定区域重写核心）", () => {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };

  it("环境无 caret API → unsupported（调用方回退 target 判定，单测走这条路径）", () => {
    expect(caretHitAt(5, 5).kind).toBe("unsupported");
  });

  it("命中非空白文本节点 → hit；无布局信息时 rect 为 null（仍算命中）", () => {
    document.body.innerHTML = `<p id="a">${LONG_EN}</p>`;
    const text = document.getElementById("a")!.firstChild as Text;
    doc.caretRangeFromPoint = () => {
      const r = document.createRange();
      r.setStart(text, 0);
      return r;
    };
    const res = caretHitAt(5, 5);
    expect(res.kind).toBe("hit");
    if (res.kind === "hit") {
      expect(res.hit.node).toBe(text);
      expect(res.hit.rect).toBeNull(); // jsdom 的 Range.getClientRects 为空 → 不可测量
    }
  });

  it("命中纯空白文本节点 → blank（图标间空格、排版缩进不触发角标）", () => {
    document.body.innerHTML = `<p id="a">    </p>`;
    const ws = document.getElementById("a")!.firstChild as Text;
    doc.caretRangeFromPoint = () => {
      const r = document.createRange();
      r.setStart(ws, 0);
      return r;
    };
    expect(caretHitAt(5, 5).kind).toBe("blank");
  });

  it("命中点落在文本行矩形之外 → blank（caret API 在空白处就近吸附的假命中被筛掉）", () => {
    document.body.innerHTML = `<p id="a">${LONG_EN}</p>`;
    const text = document.getElementById("a")!.firstChild as Text;
    doc.caretRangeFromPoint = () => {
      const r = document.createRange();
      r.setStart(text, 0);
      return r;
    };
    // jsdom 的 Range 无 getClientRects：临时补一个，测完删除
    const proto = Range.prototype as unknown as { getClientRects?: () => DOMRect[] };
    const rect = {
      left: 0,
      top: 100,
      right: 200,
      bottom: 120,
      width: 200,
      height: 20,
    } as DOMRect;
    proto.getClientRects = () => [rect];
    try {
      expect(caretHitAt(5, 5).kind).toBe("blank"); // y=5 不在 y∈[99,121] 的行内
      expect(caretHitAt(5, 105).kind).toBe("hit"); // y=105 命中该行
    } finally {
      delete proto.getClientRects;
    }
  });

  it("命中非文本节点（图片/SVG/裸元素）→ blank", () => {
    document.body.innerHTML = `<p id="a"><img src="x.png">${LONG_EN}</p>`;
    const img = document.querySelector("#a img")!;
    doc.caretRangeFromPoint = () => {
      const r = document.createRange();
      r.setStart(img, 0);
      return r;
    };
    expect(caretHitAt(5, 5).kind).toBe("blank");
  });
});

describe("engine.translateElement 单元素翻译", () => {
  beforeEach(() => vi.useFakeTimers());

  it("只译目标元素，且不推整页状态机（关键：观察器以 state=off 门控整页补扫）", async () => {
    document.body.innerHTML = `<p id="a">${LONG_EN}</p><p id="b">${LONG_EN_2}</p>`;
    const engine = makeEngine();

    engine.translateElement(document.getElementById("a")!);
    await settle();

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
    await settle();
    expect(sendMessage.mock.calls.filter(([m]) => m?.type === "translate").length).toBe(1);

    // 另一处出现同文段落：引擎文本级去重（isSkipped）应跳过
    document.body.insertAdjacentHTML("beforeend", `<p id="c">${LONG_EN}</p>`);
    engine.translateElement(document.getElementById("c")!);
    await settle();
    expect(document.getElementById("c")!.hasAttribute("data-it-src")).toBe(false);
    expect(sendMessage.mock.calls.filter(([m]) => m?.type === "translate").length).toBe(1);
  });

  it("translateAll 解除钳制：整页翻译后状态正常推进到 done", async () => {
    document.body.innerHTML = `<p id="a">${LONG_EN}</p><p id="b">${LONG_EN_2}</p>`;
    const engine = makeEngine();

    engine.translateElement(document.getElementById("a")!);
    await settle();
    expect(engine.state).toBe("off");

    void engine.translateAll();
    await settle(500); // translateUnits 是 fire-and-forget，状态推进在异步续程里
    expect(engine.state).toBe("done");
    expect(document.getElementById("b")!.hasAttribute("data-it-src")).toBe(true);
  });
});

describe("悬停角标交互", () => {
  let dispose: (() => void) | null = null;

  beforeEach(() => vi.useFakeTimers());

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

  it("停留不足不弹角标（快速划动不再满屏乱弹），停留达标才显示", () => {
    const { badge } = setup();
    const a = document.getElementById("a")!;
    stubRect(a);

    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS - 1);
    expect(badge.style.display).toBe("none"); // 还没停稳：不弹

    vi.advanceTimersByTime(1);
    expect(badge.style.display).toBe("block"); // 停够 250ms：弹出
    expect(badge.style.left).toBe("12px");
    expect(badge.style.top).toBe("42px"); // 左上角内侧（left=10+2，top=40+2）：与段落零缝隙可达

    // 块内移动（目标解析到同一候选）：角标不动
    hoverOver(a);
    expect(badge.style.display).toBe("block");

    // 移开到无关区域（body）：隐藏
    document.body.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(badge.style.display).toBe("none");
  });

  it("caret 可用时命中空白：停留再久也不弹（旧版 div 兜底在空白区乱弹的回归）", () => {
    const { badge } = setup();
    const a = document.getElementById("a")!;
    stubRect(a);
    const doc = document as { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const ws = document.createTextNode("   ");
    a.appendChild(ws);
    doc.caretRangeFromPoint = () => {
      const r = document.createRange();
      r.setStart(ws, 0);
      return r;
    };
    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: 99, clientY: 99 }));
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS + 100);
    expect(badge.style.display).toBe("none");
    delete doc.caretRangeFromPoint;
  });

  it("停留计时中移出：dwell 作废，鼠标离开后角标不再到期弹出（审查 M-1 回归）", () => {
    const { badge } = setup();
    const a = document.getElementById("a")!;
    stubRect(a);
    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS - 50); // 还差 50ms 到期
    expect(badge.style.display).toBe("none");
    a.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS + 200);
    expect(badge.style.display).toBe("none"); // 移出即作废：不再弹出
  });

  it("划词选择开始：取消已显示角标与停留计时（与划词气泡互不打架）", () => {
    const { badge } = setup();
    const a = document.getElementById("a")!;
    stubRect(a);
    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    vi.advanceTimersByTime(HOVER_SHOW_DELAY_MS);
    expect(badge.style.display).toBe("block");

    // 模拟拖选：selection 变为非 collapsed 后的 mouseover
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(a);
    sel.removeAllRanges();
    sel.addRange(range);
    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(badge.style.display).toBe("none"); // 立即收起
    sel.removeAllRanges();
  });

  it("点击角标只译该元素；翻译后同元素出「还原」角标", async () => {
    const { engine, badge } = setup();
    const a = document.getElementById("a")!;
    stubRect(a);

    hoverOver(a);
    badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(badge.style.display).toBe("none"); // 点击后角标消失
    await settle();

    expect(document.getElementById("a")!.hasAttribute("data-it-src")).toBe(true);
    expect(document.getElementById("b")!.hasAttribute("data-it-src")).toBe(false);
    expect(engine.state).toBe("off"); // 悬停单译不改整页状态

    // 已译元素再悬停：切「还原」角标（点击可只还原该段）
    hoverOver(a);
    expect(badge.style.display).toBe("block");
    expect(badge.textContent).toBe(t("restore"));
  });

  it("悬停单译一段后，其它段落仍可继续悬停翻译（功能不因 hasTranslated 自灭）", async () => {
    const { badge } = setup();
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    stubRect(a);
    stubRect(b, 10, 120);

    hoverOver(a);
    badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(a.hasAttribute("data-it-src")).toBe(true);

    // 关键：state 仍为 off → 第二段照常出角标、可译
    hoverOver(b);
    expect(badge.style.display).toBe("block");
    badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(b.hasAttribute("data-it-src")).toBe(true);
  });

  it("整页翻译后新内容不再出角标（状态机口径）；还原后恢复", async () => {
    const { engine, badge } = setup();
    stubRect(document.getElementById("a")!);

    // 整页翻译完成后：state=done 且 hasTranslated → 角标关停
    void engine.translateAll();
    await settle(500);
    expect(engine.state).not.toBe("off");

    // 换页后新增的未翻译段落（元素本身无 data-it-src）：仅因整页状态而不出角标
    document.body.insertAdjacentHTML("beforeend", `<p id="c">${LONG_EN_2}</p>`);
    const c = document.getElementById("c")!;
    stubRect(c);
    hoverOver(c);
    expect(badge.style.display).toBe("none");

    // 还原（state=off、doneTexts 清空）→ 角标恢复
    engine.restore();
    hoverOver(c);
    expect(badge.style.display).toBe("block");
  });

  it("敏感页不出角标；划词选择进行中不出角标", () => {
    const { badge } = setup(() => true);
    const a = document.getElementById("a")!;
    stubRect(a);
    hoverOver(a);
    expect(badge.style.display).toBe("none");
  });

  it("角标挂 <html> 下而非 body（body 带 transform/filter 的站点上 fixed 包含块失真的第一层防御）", () => {
    const { badge } = setup();
    expect(badge.parentElement).toBe(document.documentElement);
  });

  it("站点含块偏移（fixed 以文档为基准）：按实测位置回填，视觉位置仍贴住段落", () => {
    const { badge } = setup();
    const a = document.getElementById("a")!;
    stubRect(a, 10, 40); // 目标视口坐标：left=12，top=42（内侧贴合）
    // 模拟 body{transform} 的失真：以 style 里的局部坐标 + 滚动量(4500) 呈现于视口
    const offset = 4500;
    badge.getBoundingClientRect = () =>
      ({
        left: (parseFloat(badge.style.left) || 0) + offset,
        top: (parseFloat(badge.style.top) || 0) + offset,
        width: 20,
        height: 20,
      }) as DOMRect;

    hoverOver(a);
    expect(badge.style.display).toBe("block");
    // 回填后局部坐标被平移，实测视口位置回到段落左上角
    expect(parseFloat(badge.style.left)).toBeCloseTo(12 - offset, 0);
    expect(parseFloat(badge.style.top)).toBeCloseTo(42 - offset, 0);
    const b = badge.getBoundingClientRect();
    expect(b.left).toBeCloseTo(12, 0);
    expect(b.top).toBeCloseTo(42, 0);
  });

  it("含块为缩放失真（html zoom 类，k=1.5 叠加平移）：仿射反解后仍贴住段落（±亚像素舍入）", () => {
    const { badge } = setup();
    const a = document.getElementById("a")!;
    stubRect(a, 10, 40);
    const k = 1.5;
    const offset = 4500;
    badge.getBoundingClientRect = () =>
      ({
        left: (parseFloat(badge.style.left) || 0) * k + offset,
        top: (parseFloat(badge.style.top) || 0) * k + offset,
        width: 20,
        height: 20,
      }) as DOMRect;

    hoverOver(a);
    const b = badge.getBoundingClientRect();
    expect(Math.abs(b.left - 12)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(b.top - 42)).toBeLessThanOrEqual(1.5);
  });
});

describe("角标延迟隐藏（可点性）", () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
    vi.useRealTimers();
  });

  function setupShown(): { badge: HTMLElement; a: HTMLElement } {
    vi.useFakeTimers();
    document.body.innerHTML = `<p id="a">${LONG_EN}</p><p id="b">${LONG_EN_2}</p>`;
    const engine = makeEngine();
    dispose = initHoverTranslate({ engine, isSensitive: () => false });
    const badge = document.querySelector<HTMLElement>(".it-hover-badge")!;
    const a = document.getElementById("a")!;
    stubRect(a);
    hoverOver(a);
    expect(badge.style.display).toBe("block");
    return { badge, a };
  }

  it("移出候选先保持显示，300ms 无回访才隐藏", () => {
    const { badge, a } = setupShown();
    a.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    expect(badge.style.display).toBe("block"); // 延迟窗口内不消失（去点角标的路上）
    vi.advanceTimersByTime(299);
    expect(badge.style.display).toBe("block");
    vi.advanceTimersByTime(1);
    expect(badge.style.display).toBe("none");
  });

  it("移出后悬停到角标自身：取消隐藏，停留再久也不消失", () => {
    const { badge, a } = setupShown();
    a.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    badge.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); // 到达角标
    vi.advanceTimersByTime(1000);
    expect(badge.style.display).toBe("block");
  });

  it("移出后回到同一候选：取消隐藏", () => {
    const { badge, a } = setupShown();
    a.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); // 折返
    vi.advanceTimersByTime(1000);
    expect(badge.style.display).toBe("block");
  });
});

describe("悬停角标还原单段", () => {
  let dispose: (() => void) | null = null;

  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  function setupHover(): { engine: PageEngine; badge: HTMLElement } {
    document.body.innerHTML = `<p id="a">${LONG_EN}</p><p id="b">${LONG_EN_2}</p>`;
    const engine = makeEngine();
    dispose = initHoverTranslate({ engine, isSensitive: () => false });
    const badge = document.querySelector<HTMLElement>(".it-hover-badge")!;
    expect(badge).toBeTruthy();
    return { engine, badge };
  }

  it("译后悬停原文或译文都出「还原」角标；点击只还原该段", async () => {
    const { badge } = setupHover();
    const a = document.getElementById("a")!;
    stubRect(a);

    hoverOver(a);
    badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(a.hasAttribute("data-it-src")).toBe(true);

    // 悬停原文（在 .it-wrap 包裹层内）→ 「还原」角标
    hoverOver(a);
    expect(badge.style.display).toBe("block");
    expect(badge.textContent).toBe(t("restore"));

    // 悬停译文（.it-translated）→ 映射回原文容器，同样出「还原」
    const trans = document.querySelector<HTMLElement>(".it-translated")!;
    expect(trans).toBeTruthy();
    hoverOver(trans);
    expect(badge.style.display).toBe("block");
    expect(badge.textContent).toBe(t("restore"));

    // 点击还原：解包回原文、去标记，页面无译文残留
    badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(a.hasAttribute("data-it-src")).toBe(false);
    expect(document.querySelector(".it-translated")).toBeNull();
    expect(document.querySelector(".it-wrap")).toBeNull();
    expect(document.body.textContent).toContain(LONG_EN);
  });

  it("还原后立即可再悬停重译（文本级去重与预判缓存同步清理）", async () => {
    const { badge } = setupHover();
    const a = document.getElementById("a")!;
    stubRect(a);
    const calls = () => sendMessage.mock.calls.filter(([m]) => m?.type === "translate").length;

    hoverOver(a);
    badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(calls()).toBe(1);

    hoverOver(a); // 「还原」
    badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(a.hasAttribute("data-it-src")).toBe(false);

    // 不等待 TTL：马上悬停应出「译」（freshUnitsCache 已在点击时失效）
    hoverOver(a);
    expect(badge.style.display).toBe("block");
    expect(badge.textContent).toBe(t("translate"));
    badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(a.hasAttribute("data-it-src")).toBe(true);
    expect(calls()).toBe(2);
  });

  it("只还原目标段：同页另一段已译不受影响", async () => {
    const { badge } = setupHover();
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;
    stubRect(a, 10, 40);
    stubRect(b, 10, 120);

    for (const el of [a, b]) {
      hoverOver(el);
      badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
    }
    expect(a.hasAttribute("data-it-src")).toBe(true);
    expect(b.hasAttribute("data-it-src")).toBe(true);

    hoverOver(a); // 「还原」A
    badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(a.hasAttribute("data-it-src")).toBe(false);
    expect(b.hasAttribute("data-it-src")).toBe(true); // B 保持译文
    expect(b.textContent).toContain(LONG_EN_2); // b 自身仍是被包裹的原文
    expect(document.querySelectorAll(".it-translated").length).toBe(1); // 只剩 B 的译文
  });
});
