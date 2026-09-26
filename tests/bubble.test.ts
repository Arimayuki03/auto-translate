// @vitest-environment jsdom
/**
 * 划词翻译气泡（F-010）回归测试：
 * 1. 划词（mouseup + Selection 长度>=2）→ translateOnSelect=true 直接出气泡，
 *    mock engine.targetLanguage，走真实 translateTextStream（Port 流式回包）；
 * 2. 点「还原」（✕ 按钮）→ 立即恢复原文（M-0 回归：此前走 else 分支不清理）；
 * 3. translateOnSelect=false → 先出小「译」按钮，点击才开气泡翻译；
 * 4. Escape 关闭气泡（统一 close：清 DOM + 断流式 Port）；
 * 5. mousedown 在页面（非气泡内）关闭气泡；
 * 6. 选区塌陷后重划 → 旧小按钮被 close 清理（else 分支先 close 的回归）。
 *
 * 环境说明：
 * - initBubble 在 document/window 挂监听器且不可移除，多实例互相干扰：
 *   两个 describe 各建一个实例、各持一个激活开关（敏感页回调 = 非本实例激活即
 *   return，等同未安装），beforeEach 只激活当前实例；
 * - jsdom 的 Range 无布局方法（调用即抛）：受控 Selection 直接给假 Range 与矩形；
 * - chrome mock 每用例安装（afterEach 卸载），runtime.connect 用显式 vi.fn 覆盖，
 *   供 translateTextStream 建立流式 Port；renderTranslation 先 await getSettings()
 *   再 connect，回包前用 vi.waitFor 等 stream-start 落地。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initBubble } from "../src/content/bubble";
import { installChromeMock, uninstallChromeMock } from "./helpers/chromeMock";
import { STREAM_PORT_NAME } from "../src/shared/messages";
import { t } from "../src/shared/i18n";
import type { PageEngine } from "../src/content/engine";

type PortListener = (msg: { type: string; text?: string; delta?: string; error?: string }) => void;

/** 可控的流式 Port 桩：记录 postMessage，测试用例手工回放 delta/done */
function makePort() {
  const listeners: { onMessage: PortListener[]; onDisconnect: (() => void)[] } = {
    onMessage: [],
    onDisconnect: [],
  };
  const port = {
    name: STREAM_PORT_NAME,
    postMessage: vi.fn(),
    disconnect: vi.fn(() => listeners.onDisconnect.forEach((fn) => fn())),
    onMessage: { addListener: (fn: PortListener) => listeners.onMessage.push(fn) },
    onDisconnect: { addListener: (fn: () => void) => listeners.onDisconnect.push(fn) },
  };
  return {
    port,
    /** 模拟 background 流式回包：先推增量，再以完整译文收尾 */
    done(text: string, deltas: string[] = []): void {
      for (const delta of deltas) listeners.onMessage.forEach((fn) => fn({ type: "stream-delta", delta }));
      listeners.onMessage.forEach((fn) => fn({ type: "stream-done", text }));
    },
  };
}

type PortHandle = ReturnType<typeof makePort>;

const ttsDisabled = { enabled: false, voice: "", rate: 0 } as const;

let engine: PageEngine;
let connectMock: ReturnType<typeof vi.fn>;
const cleanups: (() => void)[] = [];

/** 推进微任务，让 renderTranslation 在 done 回包后的续程落地 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** 每个用例独立的受控 Selection：spy 掉 window.getSelection */
function stubSelection(text: string | null) {
  const sel = {
    isCollapsed: text === null,
    toString: () => text ?? "",
    rangeCount: text === null ? 0 : 1,
    // jsdom 的 Range 无 getBoundingClientRect（调用即抛）：给一个普通矩形，
    // getSelectionRect 判定合法（非 null），定位走 placeFixedInViewport 的无布局分支
    getRangeAt: () =>
      ({
        getBoundingClientRect: () =>
          ({ left: 10, top: 40, right: 210, bottom: 90, width: 200, height: 50, x: 10, y: 40, toJSON: () => ({}) }) as DOMRect,
      }) as unknown as Range,
    removeAllRanges: () => undefined,
  } as unknown as Selection;
  vi.spyOn(window, "getSelection").mockReturnValue(sel);
  return sel;
}

function mouseup(target: Element = document.body): void {
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

function bubble(): HTMLElement | null {
  return document.querySelector(".it-bubble");
}

function selButton(): HTMLElement | null {
  return document.querySelector(".it-translate-sel");
}

/** 划词 → 等 stream-start 经 Port 发出 → 回放增量与完整译文 → 等渲染落地 */
async function selectText(text: string, handle: PortHandle): Promise<void> {
  await startSelection(text, handle);
  handle.done(`【译】${text}`, ["增量"]);
  await flush();
}

/** 划词 → 等 stream-start 经 Port 发出（流保持在途，用于测关闭时的取消链路） */
async function startSelection(text: string, handle: PortHandle): Promise<void> {
  stubSelection(text);
  mouseup();
  await vi.waitFor(() => expect(handle.port.postMessage).toHaveBeenCalled());
}

/** 两个 describe 共用的环境装配：chrome mock + 激活开关切换 */
function setupEnv(active: { current: boolean }, others: { current: boolean }[]): void {
  beforeEach(() => {
    active.current = true;
    for (const o of others) o.current = false;
    document.body.innerHTML = "";
    connectMock = vi.fn();
    installChromeMock({ extra: { runtime: { connect: connectMock } } });
  });
  afterEach(() => {
    document.body.innerHTML = "";
    uninstallChromeMock();
    vi.restoreAllMocks();
  });
}

/** 划词路径装配：安装 Port 桩并让 connect 返回它 */
function armStream(): PortHandle {
  const h = makePort();
  connectMock.mockReturnValue(h.port);
  return h;
}

/** 两个实例的激活开关：describe 体在收集阶段顺序执行，模块级共享即可互见 */
const activeSelect = { current: false };
const activeButton = { current: false };

describe("划词气泡（translateOnSelect=true）", () => {
  beforeAll(() => {
    engine = { targetLanguage: "zh-CN" } as unknown as PageEngine;
    cleanups.push(initBubble(engine, true, () => !activeSelect.current, ttsDisabled));
  });
  afterAll(() => {
    cleanups.splice(0).forEach((fn) => fn());
  });
  setupEnv(activeSelect, [activeButton]);

  it("划词 → 直接出气泡，流式译文收尾，气泡带 data-it-ui 标记", async () => {
    const h = armStream();
    await selectText("hello world", h);

    const b = bubble();
    expect(b).toBeTruthy();
    expect(b!.hasAttribute("data-it-ui")).toBe(true);
    expect(b!.classList.contains("it-bubble-loading")).toBe(false); // 流结束退出 loading
    expect(b!.querySelector(".it-bubble-body")!.textContent).toBe("【译】hello world");
    // 流式请求经 Port 发出（stream-start，术语表为空不占位）
    expect(h.port.postMessage).toHaveBeenCalledWith({
      type: "stream-start",
      text: "hello world",
      targetLang: "zh-CN",
    });
  });

  it("点「还原」（✕）→ 立即恢复原文（关闭气泡 + 断开在途流）", async () => {
    const h = armStream();
    await startSelection("restore me", h); // 流保持在途

    const b = bubble();
    expect(b).toBeTruthy();
    const closeBtn = [...b!.querySelectorAll("button")].find((x) => x.textContent === "✕");
    expect(closeBtn).toBeTruthy();
    closeBtn!.click();
    expect(bubble()).toBeNull(); // DOM 已移除
    expect(h.port.disconnect).toHaveBeenCalled(); // 在途流式请求被断开
  });

  it("Escape 关闭气泡（close 清理：DOM 移除 + Port 断开）", async () => {
    const h = armStream();
    await startSelection("escape me", h); // 流保持在途
    expect(bubble()).toBeTruthy();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(bubble()).toBeNull();
    expect(h.port.disconnect).toHaveBeenCalled();
  });

  it("mousedown 在页面（非气泡内）关闭气泡", async () => {
    const h = armStream();
    await startSelection("click away", h); // 流保持在途
    expect(bubble()).toBeTruthy();

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(bubble()).toBeNull();
  });
});

describe("划词气泡（translateOnSelect=false：小按钮模式）", () => {
  beforeAll(() => {
    engine = { targetLanguage: "zh-CN" } as unknown as PageEngine;
    cleanups.push(initBubble(engine, false, () => !activeButton.current, ttsDisabled));
  });
  afterAll(() => {
    cleanups.splice(0).forEach((fn) => fn());
  });
  setupEnv(activeButton, [activeSelect]);

  it("划词先出小「译」按钮，点击才开气泡并翻译", async () => {
    const h = armStream();

    stubSelection("manual mode text");
    mouseup();
    await Promise.resolve();

    // 不直接出气泡：先出小按钮
    expect(bubble()).toBeNull();
    const btn = selButton();
    expect(btn).toBeTruthy();
    expect(btn!.textContent).toBe(t("translate"));
    expect(btn!.hasAttribute("data-it-ui")).toBe(true);

    btn!.click(); // 点按钮 → 开气泡 + 发起翻译
    await vi.waitFor(() => expect(h.port.postMessage).toHaveBeenCalled());
    h.done("【译】manual mode text");
    await flush();

    expect(selButton()).toBeNull(); // 小按钮被移除
    const b = bubble();
    expect(b).toBeTruthy();
    expect(b!.querySelector(".it-bubble-body")!.textContent).toBe("【译】manual mode text");
  });

  it("重新划词（选区塌陷）→ 小按钮被 close 清理（else 分支先 close 的回归）", () => {
    armStream();
    stubSelection("first selection");
    mouseup();
    expect(selButton()).toBeTruthy();

    // 再点空白：选区塌陷 → close（旧实现 bubble=btn 被覆盖后滞留）
    stubSelection(null);
    mouseup();
    expect(selButton()).toBeNull();
    expect(bubble()).toBeNull();
  });
});
