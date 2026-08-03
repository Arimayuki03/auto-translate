/** 划词翻译气泡（F-010）：选中文本 → 译文气泡，可复制/关闭/重试 */
import type { PageEngine } from "./engine";
import { copyText, isInsideOurUI } from "./ui";

const DEDUP_WINDOW_MS = 3000;
const MAX_RECENT = 100;

export function initBubble(engine: PageEngine, translateOnSelect: boolean): void {
  let bubble: HTMLElement | null = null;
  const recent = new Map<string, number>();

  function close(): void {
    bubble?.remove();
    bubble = null;
  }

  document.addEventListener("mouseup", (e) => {
    if (isInsideOurUI(e.target as Element)) return;
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!sel || sel.isCollapsed || text.length < 2) {
      close();
      return;
    }
    const rect = getSelectionRect(sel);
    if (!rect) return;

    const now = Date.now();
    const last = recent.get(text);
    if (last && now - last < DEDUP_WINDOW_MS) return; // 短时内同文本不重复请求
    recent.set(text, now);
    if (recent.size > MAX_RECENT) recent.delete(recent.keys().next().value as string);

    bubble = translateOnSelect ? buildBubble() : buildTranslateButton();
    position(bubble, rect);
    if (translateOnSelect) {
      void renderTranslation(bubble, text, engine);
    } else {
      const btn = bubble.querySelector("button") as HTMLButtonElement;
      btn.addEventListener("click", () => {
        btn.remove();
        bubble!.classList.remove("it-bubble-button");
        bubble!.classList.add("it-bubble-loading");
        const body = bubble!.querySelector(".it-bubble-body") as HTMLElement;
        body.style.display = "";
        void renderTranslation(bubble!, text, engine);
      });
    }
  });

  document.addEventListener("mousedown", (e) => {
    if (!isInsideOurUI(e.target as Element)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  window.addEventListener("scroll", close, true);
}

/** 翻译并渲染到气泡主体：loading → 译文 / 失败+重试 */
async function renderTranslation(bubble: HTMLElement, text: string, engine: PageEngine): Promise<void> {
  const body = bubble.querySelector(".it-bubble-body") as HTMLElement;
  body.textContent = "翻译中…";
  try {
    const result = await engine.translateText(text);
    body.textContent = result;
    bubble.classList.remove("it-bubble-loading");
  } catch {
    body.textContent = "翻译失败 ";
    const retry = document.createElement("button");
    retry.className = "it-retry";
    retry.textContent = "重试";
    retry.addEventListener("click", () => void renderTranslation(bubble, text, engine));
    body.appendChild(retry);
    bubble.classList.remove("it-bubble-loading");
  }
}

function buildBubble(): HTMLElement {
  const el = document.createElement("div");
  el.className = "it-bubble it-bubble-loading";
  el.setAttribute("data-it-ui", "");
  const body = document.createElement("div");
  body.className = "it-bubble-body";
  el.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "it-bubble-actions";
  const copy = document.createElement("button");
  copy.textContent = "复制";
  copy.addEventListener("click", () => copyText(body.textContent ?? ""));
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "关闭";
  closeBtn.addEventListener("click", () => el.remove());
  actions.append(copy, closeBtn);
  el.appendChild(actions);
  return el;
}

function buildTranslateButton(): HTMLElement {
  const el = document.createElement("div");
  el.className = "it-bubble it-bubble-button";
  el.setAttribute("data-it-ui", "");
  const btn = document.createElement("button");
  btn.className = "it-translate-sel";
  btn.textContent = "译";
  btn.title = "翻译选中内容";
  const body = document.createElement("div");
  body.className = "it-bubble-body";
  body.style.display = "none";
  el.append(btn, body);
  return el;
}

function getSelectionRect(sel: Selection): DOMRect | null {
  if (sel.rangeCount === 0) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;
  return rect;
}

/** 固定定位气泡，视口内放不下时翻到选区上方 */
function position(el: HTMLElement, rect: DOMRect): void {
  document.body.appendChild(el);
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left = rect.left;
  let top = rect.bottom + 8;
  if (top + h > innerHeight) top = rect.top - h - 8;
  left = Math.min(Math.max(left, 8), Math.max(8, innerWidth - w - 8));
  el.style.left = `${left}px`;
  el.style.top = `${Math.max(8, top)}px`;
}
