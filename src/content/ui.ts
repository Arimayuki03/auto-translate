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
    el.style.left = `${Math.max(0, bx + dx)}px`;
    el.style.top = `${Math.max(0, by + dy)}px`;
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
