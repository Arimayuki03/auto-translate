/** 划词翻译气泡（F-010）：选中文本 → 译文气泡，可拖动/复制/关闭/重试 */
import type { PageEngine } from "./engine";
import { copyText, isInsideOurUI, makeDraggable } from "./ui";

const DEDUP_WINDOW_MS = 3000;
const MAX_RECENT = 100;

export function initBubble(
  engine: PageEngine,
  translateOnSelect: boolean,
  isSensitive?: () => boolean
): void {
  let bubble: HTMLElement | null = null;
  const recent = new Map<string, number>();

  function close(): void {
    bubble?.remove();
    bubble = null;
  }

  /** 清理过期的去重条目（超过 DEDUP_WINDOW_MS），避免 Map 无限增长 */
  function pruneRecent(): void {
    const now = Date.now();
    for (const [text, ts] of recent) {
      if (now - ts >= DEDUP_WINDOW_MS) recent.delete(text);
      else break; // Map 迭代序 = 插入序，遇到未过期的即可停（近似 LRU）
    }
  }

  document.addEventListener("mouseup", (e) => {
    if (isSensitive?.()) return; // 敏感页（登录/密码/2FA 等）不提供划词翻译
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
    pruneRecent();
    const last = recent.get(text);
    if (last && now - last < DEDUP_WINDOW_MS) return; // 短时内同文本不重复请求
    recent.set(text, now);
    // 超限时删除最老条目（Map 迭代序 = 插入序）
    if (recent.size > MAX_RECENT) {
      const oldest = recent.keys().next().value as string | undefined;
      if (oldest) recent.delete(oldest);
    }

    if (translateOnSelect) {
      bubble = buildBubble();
      position(bubble, rect);
      makeDraggable(bubble, bubble.querySelector(".it-bubble-header") as HTMLElement);
      void renderTranslation(bubble, text, engine);
    } else {
      // 先显示一个小「译」按钮，点击才翻译
      const btn = document.createElement("button");
      btn.className = "it-translate-sel";
      btn.setAttribute("data-it-ui", "");
      btn.textContent = "译";
      btn.title = "翻译选中内容";
      bubble = btn;
      position(btn, rect);
      btn.addEventListener("click", () => {
        btn.remove();
        bubble = buildBubble();
        position(bubble, rect);
        makeDraggable(bubble, bubble.querySelector(".it-bubble-header") as HTMLElement);
        void renderTranslation(bubble, text, engine);
      });
    }
  });

  document.addEventListener("mousedown", (e) => {
    if (!isInsideOurUI(e.target as Element)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  // 滚动关闭气泡：用 rAF 节流，避免高频滚动事件
  let scrollRaf = 0;
  window.addEventListener(
    "scroll",
    () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        close();
      });
    },
    true
  );
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

  const header = document.createElement("div");
  header.className = "it-bubble-header";
  const title = document.createElement("span");
  title.textContent = "译文";
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.title = "关闭";
  closeBtn.addEventListener("click", () => el.remove());
  header.append(title, closeBtn);

  const body = document.createElement("div");
  body.className = "it-bubble-body";

  const actions = document.createElement("div");
  actions.className = "it-bubble-actions";
  const copy = document.createElement("button");
  copy.textContent = "复制";
  copy.addEventListener("click", () => copyText(body.textContent ?? ""));
  actions.appendChild(copy);

  el.append(header, body, actions);
  return el;
}

function getSelectionRect(sel: Selection): DOMRect | null {
  if (sel.rangeCount === 0) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;
  return rect;
}

/** 挂载并固定定位到选区旁，视口内放不下时翻到选区上方 */
function position(el: HTMLElement, rect: DOMRect): void {
  document.body.appendChild(el);
  const w = el.offsetWidth || 40;
  const h = el.offsetHeight || 20;
  let left = rect.left;
  let top = rect.bottom + 8;
  if (top + h > innerHeight) top = rect.top - h - 8;
  left = Math.min(Math.max(left, 8), Math.max(8, innerWidth - w - 8));
  top = Math.min(Math.max(top, 8), innerHeight - h - 8);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}
