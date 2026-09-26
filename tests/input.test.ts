// @vitest-environment jsdom
/**
 * 输入框翻译（F-011）回归测试：
 * 1. focusin 出「译」按钮（按钮带 data-it-ui 标记，extractor 排除依赖它）；
 * 2. 敏感页（isSensitive）抑制：不出现按钮，且已显示的按钮被隐藏；
 * 3. 点击翻译 → 回填写入 + input 事件派发（isTrusted=false 的合成事件，React 靠
 *    原型 setter 绕过 value tracker 后靠该事件感知变化）+ 按钮变「还原」+ 标记属性；
 * 4. 点击还原 → 恢复原文、清除标记、按钮回到「译」；
 * 5. 总开关关闭（isSensitive 回调即 isBlocked，在 await 后变 true）→ 放弃回填；
 * 6. destroy() 在在途翻译中调用 → 回填被中止 + 按钮被移除（总开关关闭清理链路）；
 * 7. contenteditable 字段（jsdom 缺 isContentEditable，实例上 defineProperty 注入）。
 *
 * 环境说明：initInput 在 document/window 上挂监听器且不提供监听器移除入口，
 * 多实例会互相干扰——本文件全程只建一个实例，用可变的 sensitive 标志切换行为。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initInput } from "../src/content/input";
import { t } from "../src/shared/i18n";
import type { PageEngine } from "../src/content/engine";

const engine = {
  translateText: vi.fn<(text: string) => Promise<string>>(),
  targetLanguage: "zh-CN",
} as unknown as PageEngine;
const translateMock = engine.translateText as unknown as ReturnType<typeof vi.fn>;

let sensitive = false;
const destroy = initInput(engine, true, () => sensitive);
afterAll(() => destroy());

beforeEach(() => {
  translateMock.mockReset();
  sensitive = false;
});

afterEach(() => {
  // 按钮被 placeFixedInViewport 挂到 <html> 下，body 清空不影响它，须显式移除
  document.querySelectorAll(".it-input-btn").forEach((el) => el.remove());
  document.body.innerHTML = "";
});

function makeField(value = "hello world", type = "text"): HTMLInputElement {
  const input = document.createElement("input");
  input.type = type;
  input.value = value;
  document.body.appendChild(input);
  return input;
}

function focus(f: HTMLElement): void {
  f.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
}

function button(): HTMLButtonElement {
  return document.querySelector(".it-input-btn")!;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 推进微任务，让 onButtonClick 在 resolve 后的续程（回填/finally）落地 */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("输入框翻译", () => {
  it("focusin 出「译」按钮，按钮带 data-it-ui 标记", () => {
    const f = makeField();
    focus(f);
    const b = button();
    expect(b).toBeTruthy();
    expect(b.hasAttribute("data-it-ui")).toBe(true);
    expect(b.textContent).toBe(t("translate"));
  });

  it("敏感页抑制：不出按钮，且已显示的按钮被隐藏", () => {
    const f1 = makeField("first field text");
    focus(f1);
    expect(button()).toBeTruthy();

    sensitive = true;
    const f2 = makeField("second field text");
    focus(f2);
    expect(document.querySelector(".it-input-btn")).toBeNull();
  });

  it("点击翻译 → 回填 + input 事件派发（React 兼容）+ 按钮变「还原」+ 标记", async () => {
    const f = makeField("hello world");
    focus(f);
    const b = button();
    const events: Event[] = [];
    f.addEventListener("input", (e) => events.push(e));

    const d = deferred<string>();
    translateMock.mockReturnValue(d.promise);
    expect(translateMock).not.toHaveBeenCalled();
    b.click();
    expect(translateMock).toHaveBeenCalledTimes(1);
    expect(translateMock).toHaveBeenCalledWith("hello world");

    d.resolve("你好，世界");
    await flush();

    expect(f.value).toBe("你好，世界");
    expect(f.getAttribute("data-it-input-translated")).toBe("");
    expect(f.getAttribute("data-it-input-orig")).toBe("hello world");
    expect(b.textContent).toBe(t("restore"));
    expect(b.disabled).toBe(false);
    // 合成的 input 事件（isTrusted=false）：类型必须是 input，React 变更检测靠它
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("input");
    expect(events[0]!.isTrusted).toBe(false);
  });

  it("点击还原 → 恢复原文、清除标记、按钮回到「译」", async () => {
    const f = makeField("original text");
    focus(f);
    const b = button();
    const d = deferred<string>();
    translateMock.mockReturnValue(d.promise);
    b.click();
    d.resolve("译文内容");
    await flush();
    expect(f.value).toBe("译文内容");

    b.click(); // 已翻译态：还原
    await flush();
    expect(f.value).toBe("original text");
    expect(f.hasAttribute("data-it-input-translated")).toBe(false);
    expect(f.hasAttribute("data-it-input-orig")).toBe(false);
    expect(b.textContent).toBe(t("translate"));
  });

  it("总开关关闭（isSensitive 即 isBlocked，在 await 后变 true）→ 放弃回填", async () => {
    const f = makeField("untouched text");
    focus(f);
    const b = button();
    const events: Event[] = [];
    f.addEventListener("input", (e) => events.push(e));

    const d = deferred<string>();
    translateMock.mockReturnValue(d.promise);
    b.click();
    sensitive = true; // 总开关在翻译在途时关闭
    d.resolve("迟到的译文");
    await flush();

    expect(f.value).toBe("untouched text"); // 未回填
    expect(f.hasAttribute("data-it-input-translated")).toBe(false);
    expect(f.hasAttribute("data-it-input-orig")).toBe(false);
    expect(events.length).toBe(0); // 未派发 input 事件
  });

  it("destroy() 在在途翻译中调用 → 回填被中止 + 按钮被移除", async () => {
    const f = makeField("pending text");
    focus(f);
    const b = button();
    expect(b).toBeTruthy();

    const d = deferred<string>();
    translateMock.mockReturnValue(d.promise);
    b.click();
    destroy(); // 总开关关闭 → index.ts 调 destroy（中止在途 + 关按钮）
    expect(document.querySelector(".it-input-btn")).toBeNull();

    d.resolve("迟到的译文");
    await flush();
    expect(f.value).toBe("pending text"); // 中止后放弃回填
    expect(f.hasAttribute("data-it-input-translated")).toBe(false);
  });

  it("contenteditable 字段（jsdom 缺 isContentEditable，defineProperty 注入）", async () => {
    const div = document.createElement("div");
    div.textContent = "editable text";
    // jsdom 未实现 HTMLElement.isContentEditable（恒 undefined），测试分支需手工注入
    Object.defineProperty(div, "isContentEditable", { value: true, configurable: true });
    document.body.appendChild(div);
    focus(div);
    const b = button();
    expect(b).toBeTruthy();

    const events: Event[] = [];
    div.addEventListener("input", (e) => events.push(e));
    const d = deferred<string>();
    translateMock.mockReturnValue(d.promise);
    b.click();
    d.resolve("可编辑译文");
    await flush();

    expect(div.textContent).toBe("可编辑译文");
    expect(div.getAttribute("data-it-input-translated")).toBe("");
    expect(events.some((e) => e.type === "input")).toBe(true);
  });
});
