/** content 层共享的 DOM / 剪贴板助手（阶段 4） */

/** 事件目标是否在我们注入的 UI 内（工具条/气泡/按钮） */
export function isInsideOurUI(target: Element | null): boolean {
  return !!target && typeof target.closest === "function" && !!target.closest("[data-it-ui]");
}

/** 元素是否部分进入视口 */
export function inViewport(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0;
}

/**
 * 视口优先调度的排序键：值越小越先翻译。
 * - 视口内：返回 r.top（同屏内自上而下，保持「页头先出」的阅读顺序）；
 * - 视口外：innerHeight + 到视口边缘的横向/纵向距离（越远越靠后）；
 * - 不可见元素（display:none 等 rect 全 0）：排最后（翻译它们没有可视收益）。
 * jsdom 等 rect 恒为 0 的环境全部落在最后一档 → 稳定排序退化为 DOM 顺序。
 */
export function viewportOrderKey(el: HTMLElement): number {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 && r.height <= 0) return Number.MAX_SAFE_INTEGER;
  if (r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0) {
    return Math.max(0, r.top);
  }
  const dy = r.top >= innerHeight ? r.top - innerHeight : r.bottom <= 0 ? -r.bottom : 0;
  const dx = r.left >= innerWidth ? r.left - innerWidth : r.right <= 0 ? -r.right : 0;
  return innerHeight + dy + dx;
}

/** 按谓词二分数组：返回 [通过, 未通过] */
export function partition<T>(arr: T[], pred: (t: T) => boolean): [T[], T[]] {
  const a: T[] = [];
  const b: T[] = [];
  for (const x of arr) (pred(x) ? a : b).push(x);
  return [a, b];
}

/** 复制文本到剪贴板（content 脚本无 clipboardWrite 权限时走 execCommand 兜底） */
export function copyText(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * 让固定定位元素可拖动，并区分「点击」与「拖动」。
 * 默认整元素可拖（交互元素除外）；传入 handle 则只在 handle 内按下时拖动。
 * 位移超过 threshold 视为拖动（回调 onDragEnd），否则视为点击（回调 onTap）。
 */
export function makeDraggable(
  el: HTMLElement,
  handle?: HTMLElement,
  opts?: { onDragEnd?: (x: number, y: number) => void; onTap?: () => void; threshold?: number }
): void {
  const interactive = "button,select,a,input,textarea";
  const threshold = opts?.threshold ?? 4;
  let sx = 0;
  let sy = 0;
  let bx = 0;
  let by = 0;
  let down = false;
  let dragging = false;

  el.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    if (handle && !handle.contains(t)) return;
    if (t.closest(interactive)) return;
    down = true;
    dragging = false;
    sx = e.clientX;
    sy = e.clientY;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略捕获失败 */
    }
    e.preventDefault();
  });

  el.addEventListener("pointermove", (e) => {
    if (!down) return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (!dragging) {
      if (Math.hypot(dx, dy) < threshold) return;
      dragging = true;
      bx = el.offsetLeft;
      by = el.offsetTop;
    }
    // 限位：保证至少 minVisible 像素留在视口内，防止拖出窗口后拉不回来
    const minVisible = 40;
    const elW = el.offsetWidth || minVisible;
    const elH = el.offsetHeight || minVisible;
    const left = Math.min(
      Math.max(bx + dx, elW <= minVisible ? 0 : -(elW - minVisible)),
      Math.max(0, innerWidth - minVisible)
    );
    const top = Math.min(
      Math.max(by + dy, elH <= minVisible ? 0 : -(elH - minVisible)),
      Math.max(0, innerHeight - minVisible)
    );
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.right = "auto";
  });

  const stop = (e: PointerEvent) => {
    if (!down) return;
    const wasDragging = dragging;
    down = false;
    dragging = false;
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    if (wasDragging) opts?.onDragEnd?.(el.offsetLeft, el.offsetTop);
    else opts?.onTap?.();
  };
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", () => {
    down = false;
    dragging = false;
  });
}
