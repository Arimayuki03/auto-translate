/** 划词翻译气泡（F-010）：选中文本 → 流式译文气泡（逐字增量），可拖动/复制/关闭/重试/朗读 */
import type { PageEngine } from "./engine";
import type { TtsSettings } from "../shared/types";
import { getSettings } from "../shared/storage";
import { translateTextStream } from "./translate";
import { placeFixedInViewport } from "./placement";
import { copyText, isInsideOurUI, makeDraggable } from "./ui";
import { TtsController } from "./tts";
import { t } from "../shared/i18n";

const DEDUP_WINDOW_MS = 3000;
const MAX_RECENT = 100;

export function initBubble(
  engine: PageEngine,
  translateOnSelect: boolean,
  isSensitive?: () => boolean,
  tts?: TtsSettings
): void {
  let bubble: HTMLElement | null = null;
  const recent = new Map<string, number>();
  /** 在途流式翻译的取消函数：气泡任何形式的关闭都断开 Port → background 中止在途请求 */
  let activeCancel: (() => void) | null = null;
  /** 朗读控制器：全局同一时刻至多一条播放（关闭气泡即停止）；状态直接刷到当前气泡按钮上 */
  let speakBtn: HTMLButtonElement | null = null;
  const ttsCtl = new TtsController((state, err) => {
    if (!speakBtn) return;
    speakBtn.textContent =
      state === "fetching"
        ? t("speakGenerating")
        : state === "playing"
          ? t("stop")
          : state === "error"
            ? t("speakFailed")
            : t("speak");
    speakBtn.title = state === "error" ? err || t("speakFailed") : t("speakTitle");
  });

  /** 挂「朗读」按钮（tts.enabled 时）：读气泡最终译文，流式未结束/失败态不可读 */
  function attachSpeakButton(bubbleEl: HTMLElement, eng: PageEngine): void {
    if (!tts?.enabled) return;
    const actions = bubbleEl.querySelector(".it-bubble-actions");
    if (!actions) return;
    const speak = document.createElement("button");
    speak.textContent = t("speak");
    speak.title = t("speakTitle");
    speak.addEventListener("click", () => {
      if (bubbleEl.classList.contains("it-bubble-loading")) return; // 流式翻译尚未结束
      const body = bubbleEl.querySelector(".it-bubble-body");
      if (body?.querySelector(".it-retry")) return; // 失败态没有可读的译文
      void ttsCtl.toggle(body?.textContent ?? "", eng.targetLanguage);
    });
    actions.prepend(speak);
    speakBtn = speak;
  }

  function close(): void {
    ttsCtl.stop();
    activeCancel?.();
    activeCancel = null;
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

  /** 构建气泡、定位、挂朗读按钮、发起流式翻译（两条划词路径共用） */
  function openBubble(rect: DOMRect, text: string, eng: PageEngine): void {
    bubble = buildBubble(close);
    position(bubble, rect);
    makeDraggable(bubble, bubble.querySelector(".it-bubble-header") as HTMLElement);
    attachSpeakButton(bubble, eng);
    void renderTranslation(bubble, text, eng, () => (activeCancel = null));
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
      close(); // 连续划词：取消上一条仍在途的流式请求，再开新气泡
      openBubble(rect, text, engine);
    } else {
      // 先显示一个小「译」按钮，点击才翻译
      const btn = document.createElement("button");
      btn.className = "it-translate-sel";
      btn.setAttribute("data-it-ui", "");
      btn.textContent = t("translate");
      btn.title = t("translateSelection");
      bubble = btn;
      position(btn, rect);
      btn.addEventListener("click", () => {
        btn.remove();
        openBubble(rect, text, engine);
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
    (e) => {
      // 捕获阶段会收到子元素的滚动事件：长译文在 .it-bubble-body（overflow:auto）内
      // 滚动阅读时不能把气泡关掉，只有页面本身滚动才关闭
      if (bubble && e.target instanceof Node && bubble.contains(e.target)) return;
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        close();
      });
    },
    true
  );

  /**
   * 流式翻译并渲染到气泡主体：loading → 增量逐字（rAF 节流追加，一帧最多刷一次 DOM）
   * → 流结束以完整译文收尾（术语表占位在此统一还原）/ 失败显示现有错误态+重试。
   * onSettled：流结束（成功或失败）后解除关闭时的取消引用，避免误调已结束的流。
   */
  async function renderTranslation(
    bubbleEl: HTMLElement,
    text: string,
    eng: PageEngine,
    onSettled: () => void
  ): Promise<void> {
    const body = bubbleEl.querySelector(".it-bubble-body") as HTMLElement;
    body.textContent = t("translating");
    // 术语表与整页翻译同源：按当前设置读取（划词是低频用户手势，一次小读取可接受）
    let glossary: string[] = [];
    try {
      glossary = (await getSettings()).translate.terminology ?? [];
    } catch {
      // 读取失败按无术语表处理，不阻塞翻译
    }
    if (!bubbleEl.isConnected) return; // 等待读取设置期间气泡已被关闭

    let acc = "";
    let raf = 0;
    const paint = (): void => {
      raf = 0;
      body.textContent = acc;
    };

    let cancel: (() => void) | null = null;
    try {
      const handle = translateTextStream(text, eng.targetLanguage, glossary, (delta) => {
        acc += delta;
        if (!raf && bubbleEl.isConnected) raf = requestAnimationFrame(paint);
      });
      cancel = handle.cancel;
      activeCancel = cancel;
      const result = await handle.promise;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      body.textContent = result;
      bubbleEl.classList.remove("it-bubble-loading");
    } catch {
      if (!bubbleEl.isConnected) return; // 气泡已关闭（取消导致的中止）：无 UI 可更新
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      body.textContent = `${t("translateFailed")} `;
      const retry = document.createElement("button");
      retry.className = "it-retry";
      retry.textContent = t("retry");
      retry.addEventListener("click", () => void renderTranslation(bubbleEl, text, eng, onSettled));
      body.appendChild(retry);
      bubbleEl.classList.remove("it-bubble-loading");
    } finally {
      if (raf) cancelAnimationFrame(raf);
      if (activeCancel === cancel) onSettled();
    }
  }
}

/** 构建气泡骨架；onClose 供右上角 ✕ 走统一关闭（取消在途流式请求） */
function buildBubble(onClose: () => void): HTMLElement {
  const el = document.createElement("div");
  el.className = "it-bubble it-bubble-loading";
  el.setAttribute("data-it-ui", "");

  const header = document.createElement("div");
  header.className = "it-bubble-header";
  const title = document.createElement("span");
  title.textContent = t("bubbleTitle");
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.title = t("close");
  closeBtn.addEventListener("click", () => onClose());
  header.append(title, closeBtn);

  const body = document.createElement("div");
  body.className = "it-bubble-body";

  const actions = document.createElement("div");
  actions.className = "it-bubble-actions";
  const copy = document.createElement("button");
  copy.textContent = t("copy");
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
  placeFixedInViewport(el, left, top);
}
