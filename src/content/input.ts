/** 输入框翻译（F-011）：聚焦输入框显示「译」按钮，翻译内容并回填 */
import type { PageEngine } from "./engine";
import { isInsideOurUI } from "./ui";

export function initInput(engine: PageEngine, enabled: boolean): void {
  if (!enabled) return;
  let btn: HTMLElement | null = null;
  let hideTimer: number | undefined;

  function hide(): void {
    btn?.remove();
    btn = null;
  }

  document.addEventListener("focusin", (e) => {
    clearTimeout(hideTimer);
    const el = e.target as HTMLElement;
    if (!isTranslatableField(el) || isInsideOurUI(el)) return;
    showButton(el, engine);
  });

  // 延迟隐藏，避免点击「译」按钮时（mousedown 已 preventDefault 保焦点）被误收起
  document.addEventListener("focusout", () => {
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, 150);
  });

  window.addEventListener("scroll", hide, true);
}

function isTranslatableField(el: HTMLElement): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return ["text", "search", "email", "url"].includes(el.type);
  return el.isContentEditable;
}

function getFieldText(el: HTMLElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
  return el.textContent ?? "";
}

function setFieldText(el: HTMLElement, text: string): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = text;
  }
}

function showButton(field: HTMLElement, engine: PageEngine): void {
  document.querySelector(".it-input-btn")?.remove();

  const btn = document.createElement("button");
  btn.className = "it-input-btn";
  btn.textContent = "译";
  btn.title = "翻译输入内容";
  btn.addEventListener("mousedown", (e) => e.preventDefault()); // 保持输入框焦点

  btn.addEventListener("click", async () => {
    const text = getFieldText(field).trim();
    if (!text) return;
    btn.disabled = true;
    btn.textContent = "…";
    try {
      const result = await engine.translateText(text);
      setFieldText(field, result);
      btn.remove();
    } catch {
      btn.textContent = "失败";
      btn.disabled = false;
      setTimeout(() => (btn.textContent = "译"), 1200);
    }
  });

  const r = field.getBoundingClientRect();
  btn.style.top = `${Math.max(8, r.top - 28)}px`;
  btn.style.right = `${Math.max(8, innerWidth - r.right)}px`;
  document.body.appendChild(btn);
}
