/** 顶部悬浮工具条：翻译开关 / 模式 / 目标语言 / 设置 / 状态 / 收起（阶段 4） */
import type { DisplayMode } from "../shared/types";
import type { EngineState, EngineStats, PageEngine } from "./engine";

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

export class Toolbar {
  private el: HTMLElement;
  private toggleBtn: HTMLButtonElement;
  private modeSelect: HTMLSelectElement;
  private statusEl: HTMLElement;

  constructor(private engine: PageEngine) {
    this.el = document.createElement("div");
    this.el.className = "it-toolbar";
    this.el.setAttribute("data-it-ui", "");

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

    this.statusEl = document.createElement("span");
    this.statusEl.className = "it-status";

    const collapseBtn = document.createElement("button");
    collapseBtn.className = "it-collapse";
    collapseBtn.textContent = "收起";
    collapseBtn.title = "折叠工具条";
    collapseBtn.addEventListener("click", () => this.el.classList.toggle("it-collapsed"));

    this.el.append(this.toggleBtn, this.modeSelect, langSelect, settingsBtn, this.statusEl, collapseBtn);
    document.body.appendChild(this.el);

    engine.onStateChange = (state, stats) => this.setStatus(state, stats);
    this.setStatus(engine.state, { done: 0, error: 0, total: 0 });
  }

  /** 快捷键轮换模式（同步 select） */
  cycleMode(): void {
    const next = MODES[(MODES.indexOf(this.engine.renderer.getMode()) + 1) % MODES.length];
    this.engine.renderer.setMode(next);
    this.modeSelect.value = next;
  }

  destroy(): void {
    this.engine.onStateChange = undefined;
    this.el.remove();
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
}
