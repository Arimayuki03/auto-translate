/** 悬浮翻译按钮：红色小圆圈，点开显示详细设置（可拖动 / 位置记忆） */
import type { DisplayMode } from "../shared/types";
import type { EngineState, EngineStats, PageEngine } from "./engine";
import { copyText, makeDraggable } from "./ui";

const MODES: DisplayMode[] = ["bilingual", "translated", "original"];
const MODE_LABEL: Record<DisplayMode, string> = {
  bilingual: "双语对照",
  translated: "仅译文",
  original: "原文",
};
const LANGUAGES: [string, string][] = [
  ["zh-CN", "简体中文"],
  ["en", "English"],
  ["ja", "日本語"],
  ["ko", "한국어"],
];

const STORAGE_KEY = "it-toolbar-state";

interface ToolbarState {
  x?: number;
  y?: number;
  expanded?: boolean;
}

export class Toolbar {
  private el: HTMLElement;
  private fab: HTMLElement;
  private panel: HTMLElement;
  private toggleBtn: HTMLButtonElement;
  private modeSelect: HTMLSelectElement;
  private statusEl: HTMLElement;

  constructor(private engine: PageEngine) {
    this.el = document.createElement("div");
    this.el.className = "it-toolbar";
    this.el.setAttribute("data-it-ui", "");

    // 红色小圆圈（默认态）：点击展开，拖动移动
    this.fab = document.createElement("div");
    this.fab.className = "it-fab";
    this.fab.textContent = "译";
    this.fab.title = "打开翻译设置";
    this.fab.setAttribute("role", "button");

    // 展开后的详细设置面板
    this.panel = document.createElement("div");
    this.panel.className = "it-panel";

    const grip = document.createElement("span");
    grip.className = "it-drag";
    grip.textContent = "⠿";
    grip.title = "拖动移动工具条";

    this.toggleBtn = document.createElement("button");
    this.toggleBtn.className = "it-toggle";
    this.toggleBtn.textContent = "翻译";
    this.toggleBtn.addEventListener("click", () => this.onToggle());

    this.modeSelect = document.createElement("select");
    for (const m of MODES) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = MODE_LABEL[m];
      this.modeSelect.appendChild(opt);
    }
    this.modeSelect.value = engine.renderer.getMode();
    this.modeSelect.addEventListener("change", () =>
      engine.renderer.setMode(this.modeSelect.value as DisplayMode)
    );

    const langSelect = document.createElement("select");
    langSelect.className = "it-lang-select";
    for (const [code, label] of LANGUAGES) {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = label;
      langSelect.appendChild(opt);
    }
    langSelect.value = engine.targetLanguage;
    langSelect.addEventListener("change", () => this.onLangChange(langSelect.value));

    const settingsBtn = document.createElement("button");
    settingsBtn.className = "it-settings";
    settingsBtn.textContent = "设置";
    settingsBtn.title = "打开设置页";
    settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

    const copyBtn = document.createElement("button");
    copyBtn.className = "it-copy-all";
    copyBtn.textContent = "复制译文";
    copyBtn.title = "复制整页译文到剪贴板";
    copyBtn.addEventListener("click", () => this.copyTranslations());

    this.statusEl = document.createElement("span");
    this.statusEl.className = "it-status";

    const closeBtn = document.createElement("button");
    closeBtn.className = "it-close";
    closeBtn.textContent = "✕";
    closeBtn.title = "收起为圆点";
    closeBtn.addEventListener("click", () => this.setExpanded(false));

    this.panel.append(
      grip,
      this.toggleBtn,
      this.modeSelect,
      langSelect,
      settingsBtn,
      copyBtn,
      this.statusEl,
      closeBtn
    );
    this.el.append(this.fab, this.panel);
    document.body.appendChild(this.el);

    // 红点：拖动移动 / 轻点展开（handle 传 undefined，整个红点可拖且可点）
    makeDraggable(this.el, undefined, {
      onDragEnd: () => this.saveState(),
      onTap: () => this.setExpanded(true),
      threshold: 6,
    });

    void this.restoreState();

    engine.onStateChange = (state, stats) => this.setStatus(state, stats);
    this.setStatus(engine.state, { done: 0, error: 0, total: 0 });
  }

  /** 快捷键轮换模式（同步 select） */
  cycleMode(): void {
    const next = MODES[(MODES.indexOf(this.engine.renderer.getMode()) + 1) % MODES.length];
    this.engine.renderer.setMode(next);
    this.modeSelect.value = next;
  }

  /** 复制整页译文（按页面顺序）到剪贴板 */
  private copyTranslations(): void {
    const texts = Array.from(
      document.querySelectorAll(".it-translated:not(.it-pending):not(.it-error)")
    )
      .map((el) => (el.textContent ?? "").trim())
      .filter(Boolean);
    if (texts.length === 0) {
      this.statusEl.textContent = "暂无译文";
      return;
    }
    const ok = copyText(texts.join("\n\n"));
    this.statusEl.textContent = ok ? `已复制 ${texts.length} 段` : "复制失败";
  }

  destroy(): void {
    this.engine.onStateChange = undefined;
    this.el.remove();
  }

  private setExpanded(v: boolean): void {
    this.el.classList.toggle("it-expanded", v);
    this.saveState();
  }

  private onToggle(): void {
    if (this.engine.state === "off") {
      void this.engine.translateAll();
    } else {
      this.engine.restore();
    }
  }

  private onLangChange(lang: string): void {
    this.engine.setTargetLang(lang);
    this.engine.restore();
    void this.engine.translateAll();
  }

  private setStatus(state: EngineState, stats: EngineStats): void {
    this.toggleBtn.disabled = state === "translating";
    this.toggleBtn.textContent = state === "off" ? "翻译" : "还原";
    if (state === "translating") this.statusEl.textContent = "翻译中…";
    else if (state === "done") this.statusEl.textContent = `共 ${stats.total} 段完成`;
    else if (state === "partial") this.statusEl.textContent = `共 ${stats.total} 段，${stats.error} 段失败`;
    else this.statusEl.textContent = "未翻译";
  }

  private saveState(): void {
    const state: ToolbarState = {
      x: this.el.offsetLeft,
      y: this.el.offsetTop,
      expanded: this.el.classList.contains("it-expanded"),
    };
    void chrome.storage.local.set({ [STORAGE_KEY]: state });
  }

  private async restoreState(): Promise<void> {
    const res = await chrome.storage.local.get(STORAGE_KEY);
    const st = res[STORAGE_KEY] as ToolbarState | undefined;
    if (!st) return;
    if (typeof st.x === "number" && typeof st.y === "number") {
      this.el.style.left = `${st.x}px`;
      this.el.style.top = `${st.y}px`;
      this.el.style.right = "auto";
    }
    if (st.expanded) this.el.classList.add("it-expanded");
  }
}
