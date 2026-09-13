/** 悬浮翻译按钮：红色小圆圈，点开显示详细设置（可拖动 / 位置记忆） */
import type { DisplayMode } from "../shared/types";
import type { EngineState, EngineStats, PageEngine } from "./engine";
import { copyText, makeDraggable } from "./ui";
import { currentHost, currentPageKey, savePerSite, setPageDisabled } from "./perSite";

const MODES: DisplayMode[] = ["bilingual", "translated"];
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

/** 只记忆位置，不记忆展开态——红点始终默认收起（点击才展开），避免每次重载/换页都弹开面板 */
interface ToolbarState {
  x?: number;
  y?: number;
}

export class Toolbar {
  private el: HTMLElement;
  private fab: HTMLElement;
  private panel: HTMLElement;
  private toggleBtn: HTMLButtonElement;
  private modeSelect: HTMLSelectElement;
  private statusEl: HTMLElement;
  private diagBtn: HTMLButtonElement;

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

    // 显示模式：双语对照 / 仅译文（「原文」用「还原」切换，不在此列）
    this.modeSelect = document.createElement("select");
    for (const m of MODES) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = MODE_LABEL[m];
      this.modeSelect.appendChild(opt);
    }
    this.modeSelect.value =
      engine.renderer.getMode() === "original" ? "bilingual" : engine.renderer.getMode();
    this.modeSelect.addEventListener("change", () => {
      engine.renderer.setMode(this.modeSelect.value as DisplayMode);
      void savePerSite(currentHost(), {
        targetLang: engine.targetLanguage,
        displayMode: this.modeSelect.value as DisplayMode,
      });
    });

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

    const copyBtn = document.createElement("button");
    copyBtn.className = "it-copy-all";
    copyBtn.textContent = "复制译文";
    copyBtn.title = "复制整页译文到剪贴板";
    copyBtn.addEventListener("click", () => this.copyTranslations());

    this.statusEl = document.createElement("span");
    this.statusEl.className = "it-status";

    // 诊断信息复制按钮：仅在有翻译错误时显示，内容脱敏（绝不含 API Key）
    this.diagBtn = document.createElement("button");
    this.diagBtn.className = "it-copy-all";
    this.diagBtn.textContent = "复制诊断信息";
    this.diagBtn.title = "复制脱敏的错误诊断信息（不含 API Key），便于反馈问题";
    this.diagBtn.style.display = "none";
    this.diagBtn.addEventListener("click", () => this.copyDiagnostic());

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
      copyBtn,
      this.statusEl,
      this.diagBtn,
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

    // 窗口缩放变小可能把工具条挤出视口，重新吸附回来
    window.addEventListener("resize", this.onResize);

    engine.onStateChange = (state, stats) => this.setStatus(state, stats);
    this.setStatus(engine.state, { done: 0, error: 0, total: 0 });
  }

  /** resize 监听用具名方法：destroy 时需精确移除，避免 SPA 换页重建工具条时监听泄漏累积。
   *  用 rAF 节流，避免高频 resize 时读写布局引起抖动。 */
  private resizeRaf = 0;
  private onResize = (): void => {
    if (this.resizeRaf) return;
    this.resizeRaf = requestAnimationFrame(() => {
      this.resizeRaf = 0;
      this.clampToViewport();
    });
  };

  /** 快捷键轮换显示模式（双语/仅译文，原文用「还原」） */
  cycleMode(): void {
    const next = MODES[(MODES.indexOf(this.engine.renderer.getMode()) + 1) % MODES.length];
    this.engine.renderer.setMode(next);
    this.modeSelect.value = next;
    void savePerSite(currentHost(), {
      targetLang: this.engine.targetLanguage,
      displayMode: next,
    });
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

  /** 敏感页（登录/密码/2FA 等）隐藏工具条，避免诱导翻译敏感内容 */
  setSensitive(v: boolean): void {
    this.el.classList.toggle("it-toolbar-sensitive", v);
  }

  destroy(): void {
    this.engine.onStateChange = undefined;
    window.removeEventListener("resize", this.onResize);
    if (this.resizeRaf) cancelAnimationFrame(this.resizeRaf);
    this.el.remove();
  }

  private setExpanded(v: boolean): void {
    this.el.classList.toggle("it-expanded", v);
    this.clampToViewport();
    this.saveState();
  }

  /** 把工具条重新吸附回视口内（收起/展开尺寸变化后，防止跑到窗口外） */
  private clampToViewport(): void {
    const minVisible = 40;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    if (!w || !h) return;
    const left = Math.min(Math.max(this.el.offsetLeft, 0), Math.max(0, innerWidth - minVisible));
    const top = Math.min(Math.max(this.el.offsetTop, 0), Math.max(0, innerHeight - minVisible));
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
    this.el.style.right = "auto";
  }

  private onToggle(): void {
    if (this.engine.state === "off") {
      void this.engine.translateAll();
      void savePerSite(currentHost(), {
        targetLang: this.engine.targetLanguage,
        displayMode: this.engine.renderer.getMode(),
      });
      // 手动翻译 → 该子页恢复自动翻译（只影响本子页）
      void setPageDisabled(currentPageKey(), false);
    } else {
      this.engine.restore();
      void savePerSite(currentHost(), {
        targetLang: this.engine.targetLanguage,
        displayMode: this.engine.renderer.getMode(),
      });
      // 手动还原 → 该子页禁用自动翻译（只影响本子页，同站其它子页不受影响）
      void setPageDisabled(currentPageKey(), true);
    }
  }

  private onLangChange(lang: string): void {
    this.engine.setTargetLang(lang);
    this.engine.restore();
    void this.engine.translateAll();
    void savePerSite(currentHost(), {
      targetLang: lang,
      displayMode: this.engine.renderer.getMode(),
    });
    // 主动改语言并翻译 → 该子页恢复自动翻译
    void setPageDisabled(currentPageKey(), false);
  }

  private setStatus(state: EngineState, stats: EngineStats): void {
    this.toggleBtn.disabled = state === "translating";
    this.toggleBtn.textContent = state === "off" ? "翻译" : "还原";
    const err = this.engine.lastError;
    if (state === "translating") {
      this.statusEl.textContent = "翻译中…";
    } else if (state === "done") {
      this.statusEl.textContent = `共 ${stats.done} 段完成`;
    } else if (state === "partial") {
      // 失败原因带上具体错误类型（如「主 API 鉴权失败（401/403）」），不再只显示笼统的失败数
      this.statusEl.textContent = `共 ${stats.done} 段完成，${stats.error} 段失败${
        err ? `：${shorten(err.message, 60)}` : ""
      }`;
    } else {
      this.statusEl.textContent = "未翻译";
    }
    // 有可诊断的错误时显示「复制诊断信息」按钮
    this.diagBtn.style.display = state === "partial" && err ? "" : "none";
  }

  /** 复制脱敏诊断信息：provider / 端点 / 主机 / 状态码 / 错误码，绝不含 API Key */
  private copyDiagnostic(): void {
    const err = this.engine.lastError;
    if (!err) {
      this.statusEl.textContent = "暂无错误信息";
      return;
    }
    const d = err.diagnostic;
    const lines = [
      `[auto-translate 诊断] ${new Date().toISOString()}`,
      `错误：${err.message}`,
      ...(err.errorCode ? [`错误码：${err.errorCode}`] : []),
      ...(d?.provider ? [`通道：${d.provider}`] : []),
      ...(d?.source ? [`来源：${d.source === "main" ? "主 API" : "备用 API"}`] : []),
      ...(d?.endpoint ? [`端点：${d.endpoint}`] : []),
      ...(d?.hostname ? [`主机：${d.hostname}`] : []),
      ...(d?.status ? [`HTTP 状态：${d.status}`] : []),
    ];
    const ok = copyText(lines.join("\n"));
    this.statusEl.textContent = ok ? "诊断信息已复制" : "复制失败";
  }

  private saveState(): void {
    const state: ToolbarState = {
      x: this.el.offsetLeft,
      y: this.el.offsetTop,
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
    this.clampToViewport(); // 保存的位置可能超出当前窗口，吸附回来
  }
}

/** 截断过长文本用于状态行展示 */
function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
