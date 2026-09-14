/** 输入框翻译（F-011）：聚焦输入框显示「译」按钮；鼠标一移动即隐藏；可切换翻译/还原 */
import type { PageEngine } from "./engine";
import { placeFixedInViewport } from "./placement";
import { isInsideOurUI } from "./ui";
import { t } from "../shared/i18n";

export function initInput(
  engine: PageEngine,
  enabled: boolean,
  isSensitive?: () => boolean
): void {
  if (!enabled) return;
  let btn: HTMLElement | null = null;
  let field: HTMLElement | null = null;
  let hideTimer: number | undefined;

  function hide(): void {
    btn?.remove();
    btn = null;
    // 释放 field 引用：若输入框已被页面移除，避免持有已脱离 DOM 的元素引用阻碍 GC。
    // 仍连接的 field 保留，以便点击已聚焦输入框时重新显示按钮。
    if (field && !field.isConnected) field = null;
  }

  /** 定位按钮到输入框上方/下方（视口坐标；含块偏移校正见 placement.ts） */
  function positionButton(): void {
    if (!btn || !field) return;
    const r = field.getBoundingClientRect();
    const btnW = btn.offsetWidth || 32;
    const top = r.top > 40 ? Math.max(8, r.top - 30) : r.bottom + 4;
    const left = Math.min(Math.max(8, r.right - btnW), Math.max(8, innerWidth - btnW - 8));
    btn.style.right = "auto"; // 保证以 left/top 为定位基准
    placeFixedInViewport(btn, left, top);
  }

  function showButton(f: HTMLElement): void {
    hide();
    field = f;
    const b = document.createElement("button");
    b.className = "it-input-btn";
    b.textContent = f.hasAttribute("data-it-input-translated") ? t("restore") : t("translate");
    b.title = t("inputTranslateTitle");
    b.addEventListener("mousedown", (e) => e.preventDefault()); // 保持输入框焦点
    b.addEventListener("click", () => void onButtonClick(b, f));
    document.body.appendChild(b);
    btn = b;
    positionButton();
  }

  async function onButtonClick(b: HTMLButtonElement, f: HTMLElement): Promise<void> {
    // 已翻译 → 还原原文
    if (f.hasAttribute("data-it-input-translated")) {
      const orig = f.getAttribute("data-it-input-orig");
      if (orig !== null) setFieldText(f, orig);
      f.removeAttribute("data-it-input-translated");
      f.removeAttribute("data-it-input-orig");
      b.textContent = t("translate");
      return;
    }
    const text = getFieldText(f).trim();
    if (!text) return;
    b.disabled = true;
    b.textContent = "…";
    try {
      const result = await engine.translateText(text);
      if (!f.hasAttribute("data-it-input-orig")) {
        f.setAttribute("data-it-input-orig", getFieldText(f));
      }
      setFieldText(f, result);
      f.setAttribute("data-it-input-translated", "");
      b.textContent = t("restore"); // 按钮保留，可再点还原
    } catch {
      b.textContent = t("inputFailed");
      setTimeout(() => (b.textContent = t("translate")), 1200);
    } finally {
      b.disabled = false;
    }
  }

  document.addEventListener("focusin", (e) => {
    clearTimeout(hideTimer);
    if (isSensitive?.()) {
      hide(); // 敏感页（登录/密码/2FA 等）不提供输入框翻译
      return;
    }
    const el = e.target as HTMLElement;
    if (!isTranslatableField(el) || isInsideOurUI(el)) return;
    showButton(el);
  });

  // 滚轮 / 滚动页面即隐藏（鼠标移动不影响，方便移动到按钮上点击）
  const hideOnScroll = (): void => {
    if (btn) hide();
  };
  window.addEventListener("wheel", hideOnScroll, { passive: true });
  window.addEventListener("scroll", hideOnScroll, true);

  // 点击输入框以外的区域隐藏；点击已聚焦的输入框时重新显示（滚动隐藏后焦点未变，不会触发 focusin）
  document.addEventListener("mousedown", (e) => {
    if (!field || isSensitive?.()) return;
    const target = e.target as Node;
    const onField = target === field || field.contains(target);
    const fieldFocused = !!document.activeElement && field.contains(document.activeElement);
    if (onField && !btn && fieldFocused) {
      showButton(field); // 重新显示
      return;
    }
    if (!onField && !(btn && btn.contains(target))) hide();
  });

  // 失焦隐藏（Tab 移开 / 点击别处兜底）
  document.addEventListener("focusout", () => {
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, 150);
  });
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
