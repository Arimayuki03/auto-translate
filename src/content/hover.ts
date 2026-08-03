/** 段落级翻译按钮（F-015）：悬停未译段落显示「翻译」，点击只译该段 */
import type { PageEngine } from "./engine";
import { isInsideOurUI } from "./ui";

/** 常见的“文本块”选择器（不含 div，避免大面积布局元素上频繁冒按钮） */
const BLOCK_SELECTOR =
  "p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,dd,dt,figcaption,summary";

export function initHover(engine: PageEngine): void {
  let btn: HTMLElement | null = null;
  let currentBlock: HTMLElement | null = null;

  function hide(): void {
    btn?.remove();
    btn = null;
    currentBlock = null;
  }

  function show(block: HTMLElement): void {
    if (block === currentBlock) return; // 同一块内鼠标在子元素间移动，不重建
    btn?.remove();
    btn = document.createElement("button");
    btn.className = "it-hover-btn";
    btn.textContent = "翻译";
    btn.title = "翻译该段落";
    btn.addEventListener("click", () => {
      btn!.remove();
      btn = null;
      currentBlock = null;
      void engine.translateElement(block);
    });

    const r = block.getBoundingClientRect();
    btn.style.top = `${Math.max(8, r.top)}px`;
    btn.style.left = `${Math.max(8, r.right - 64)}px`;
    document.body.appendChild(btn);
    currentBlock = block;
  }

  document.addEventListener(
    "mouseover",
    (e) => {
      // 鼠标落在我们自己 UI（含按钮）上时不隐藏，保证按钮可点
      if (btn?.contains(e.target as Node)) return;
      if (isInsideOurUI(e.target as Element)) {
        hide();
        return;
      }
      const block = (e.target as HTMLElement).closest(BLOCK_SELECTOR) as HTMLElement | null;
      if (
        block &&
        !block.hasAttribute("data-it-src") &&
        !block.hasAttribute("data-it-inside")
      ) {
        const text = (block.textContent ?? "").replace(/\s+/g, " ").trim();
        if (!engine.isSkipped(text)) {
          show(block);
          return;
        }
      }
      hide();
    },
    true
  );

  window.addEventListener("scroll", hide, true);
}
