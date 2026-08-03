/** content 层共享的 DOM / 剪贴板助手（阶段 4） */

/** 事件目标是否在我们注入的 UI 内（工具条/气泡/按钮） */
export function isInsideOurUI(target: Element | null): boolean {
  return !!target && typeof target.closest === "function" && !!target.closest("[data-it-ui]");
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
