// @vitest-environment jsdom
/**
 * fixed 浮层视口级定位（placeFixedInViewport）回归测试：
 * - 挂载点重定位：浮层被移到 <html> 下（防御 body 级 transform 包含块），已挂对则不搬移；
 * - 未渲染元素（rect 宽高全 0）：按视口语义直接写坐标（取整）；
 * - 纯平移失真（body 挂 transform: translateY）：两点采样反解偏移，一次写入精确落位；
 * - 等比缩放失真（html zoom）：解出实际比例 k 并按 k 换算写入。
 * jsdom 不做真实布局，getBoundingClientRect 按用例 mock（left/top 随 style.left/top 与失真模型推得）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { placeFixedInViewport } from "../src/content/placement";

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** mock getBoundingClientRect：left/top 由 style.left/top 数值 + 失真偏移函数推得 */
function mockRects(
  distort: (left: number, top: number) => { left: number; top: number }
): void {
  const proto = HTMLElement.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
  };
  vi.spyOn(proto, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const left = parseFloat(this.style.left || "0");
    const top = parseFloat(this.style.top || "0");
    const p = distort(left, top);
    return {
      x: p.left,
      y: p.top,
      left: p.left,
      top: p.top,
      right: p.left + 40,
      bottom: p.top + 20,
      width: 40,
      height: 20,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

describe("placeFixedInViewport 挂载与未渲染分支", () => {
  it("未渲染（rect 全 0）时按视口语义直接写坐标并取整", () => {
    const el = document.createElement("div");
    placeFixedInViewport(el, 123.6, 45.2);
    expect(el.style.left).toBe("124px");
    expect(el.style.top).toBe("45px");
  });

  it("挂载点重定位到 <html> 下", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    placeFixedInViewport(el, 10, 20);
    expect(el.parentElement).toBe(document.documentElement);
  });

  it("已在 <html> 下时不重复搬移", () => {
    const el = document.createElement("div");
    document.documentElement.appendChild(el);
    placeFixedInViewport(el, 10, 20);
    expect(el.parentElement).toBe(document.documentElement);
  });
});

describe("placeFixedInViewport 平移失真（body 挂 transform）", () => {
  it("含块偏移被反解：写入坐标补偿偏移，视口落位精确", () => {
    // body 挂 transform: translateY(-800px)（滚动 800px 的典型失真）：
    // local 坐标 → 视口坐标恒偏 +800（渲染坐标 = local + 800）
    const el = document.createElement("div");
    document.body.appendChild(el);
    mockRects((left, top) => ({ left: left + 800, top: top + 800 }));

    placeFixedInViewport(el, 100, 200);
    // 想让视口位置是 (100,200)，写入需为 (100-800, 200-800)
    expect(el.style.left).toBe("-700px");
    expect(el.style.top).toBe("-600px");
  });
});

describe("placeFixedInViewport 缩放失真（html zoom）", () => {
  it("等比缩放解出 k，写入按 k 换算", () => {
    // html zoom=1.25：渲染坐标 = local × 1.25
    const el = document.createElement("div");
    document.body.appendChild(el);
    mockRects((left, top) => ({ left: left * 1.25, top: top * 1.25 }));

    placeFixedInViewport(el, 100, 200);
    // k=1.25：写入 (100/1.25, 200/1.25) = (80, 160)
    expect(el.style.left).toBe("80px");
    expect(el.style.top).toBe("160px");
  });
});
