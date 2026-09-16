/** 悬浮翻译按钮：红色小圆圈，点开显示详细设置（可拖动 / 位置记忆） */
import type { DisplayMode } from "../shared/types";
import type { EngineState, EngineStats, PageEngine } from "./engine";
import { placeFixedInViewport } from "./placement";
import { copyText, makeDraggable } from "./ui";
import { currentHost, currentPageKey, savePerSite, setPageDisabled } from "./perSite";
import { t } from "../shared/i18n";

const MODES: DisplayMode[] = ["bilingual", "translated"];
const MODE_LABEL: Record<DisplayMode, string> = {
  bilingual: t("modeBilingual"),
  translated: t("modeTranslated"),
  original: t("modeOriginal"),
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
    this.fab.textContent = t("translate");
    this.fab.title = t("fabTitle");
    this.fab.setAttribute("role", "button");

    // 展开后的详细设置面板
    this.panel = document.createElement("div");
    this.panel.className = "it-panel";

    const grip = document.createElement("span");
    grip.className = "it-drag";
    grip.textContent = "⠿";
    grip.title = t("dragTitle");

    this.toggleBtn = document.createElement("button");
    this.toggleBtn.className = "it-toggle";
    this.toggleBtn.textContent = t("toggleTranslate");
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
    copyBtn.textContent = t("copyAll");
    copyBtn.title = t("copyAllTitle");
    copyBtn.addEventListener("click", () => this.copyTranslations());

    this.statusEl = document.createElement("span");
    this.statusEl.className = "it-status";

    // 诊断信息复制按钮：仅在有翻译错误时显示，内容脱敏（绝不含 API Key）
    this.diagBtn = document.createElement("button");
    this.diagBtn.className = "it-copy-all";
    this.diagBtn.textContent = t("copyDiagnostic");
    this.diagBtn.title = t("copyDiagnosticTitle");
    this.diagBtn.style.display = "none";
    this.diagBtn.addEventListener("click", () => this.copyDiagnostic());

    const closeBtn = document.createElement("button");
    closeBtn.className = "it-close";
    closeBtn.textContent = "✕";
    closeBtn.title = t("collapseTitle");
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
    this.anchorToCorner();

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
      this.statusEl.textContent = t("noTranslations");
      return;
    }
    const ok = copyText(texts.join("\n\n"));
    this.statusEl.textContent = ok ? t("copiedCount", texts.length) : t("copyFailed");
  }

  /** 初始定位到视口右上角（12px 边距）。placeFixedInViewport 会同时把工具条重挂到
   *  <html>：body 带 transform/filter 的站点上，挂在 body 的 fixed 元素随文档滚走。
   *  敏感页隐藏态量不到渲染位置（rect 全 0），由 placement 的兜底路径直写，恢复显示
   *  时在 setSensitive(false) 里再吸附一次。 */
  private anchorToCorner(): void {
    const w = this.el.offsetWidth || 38; // fab 收起态宽度
    this.el.style.right = "auto"; // 改以 left/top 为定位基准（与拖动/吸附逻辑一致）
    placeFixedInViewport(this.el, Math.max(8, innerWidth - w - 12), 12);
  }

  /** 敏感页（登录/密码/2FA 等）隐藏工具条，避免诱导翻译敏感内容 */
  setSensitive(v: boolean): void {
    this.el.classList.toggle("it-toolbar-sensitive", v);
    if (!v) this.clampToViewport(); // 隐藏期间错过定位校正，显示时补一次视口吸附
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
    this.toggleBtn.textContent = state === "off" ? t("toggleTranslate") : t("toggleRestore");
    const err = this.engine.lastError;
    if (state === "translating") {
      this.statusEl.textContent = t("translating");
    } else if (state === "done") {
      this.statusEl.textContent = t("doneCount", stats.done);
    } else if (state === "partial") {
      // 失败原因带上具体错误类型（如「主 API 鉴权失败（401/403）」），不再只显示笼统的失败数
      this.statusEl.textContent = t(
        "partialCount",
        stats.done,
        stats.error,
        err ? shorten(err.message, 60) : ""
      );
    } else {
      this.statusEl.textContent = t("notTranslated");
    }
    // 有可诊断的错误时显示「复制诊断信息」按钮
    this.diagBtn.style.display = state === "partial" && err ? "" : "none";
  }

  /** 复制脱敏诊断信息：provider / 端点 / 主机 / 状态码 / 错误码，绝不含 API Key */
  private copyDiagnostic(): void {
    const err = this.engine.lastError;
    if (!err) {
      this.statusEl.textContent = t("noErrorInfo");
      return;
    }
    const d = err.diagnostic;
    const lines = [
      `${t("diagHeader")} ${new Date().toISOString()}`,
      `${t("diagError")}：${err.message}`,
      ...(err.errorCode ? [`${t("diagErrorCode")}：${err.errorCode}`] : []),
      ...(d?.provider ? [`${t("diagProvider")}：${d.provider}`] : []),
      ...(d?.source
        ? [`${t("diagSource")}：${d.source === "main" ? t("diagSourceMain") : t("diagSourceBackup")}`]
        : []),
      ...(d?.endpoint ? [`${t("diagEndpoint")}：${d.endpoint}`] : []),
      ...(d?.hostname ? [`${t("diagHostname")}：${d.hostname}`] : []),
      ...(d?.status ? [`${t("diagHttpStatus")}：${d.status}`] : []),
    ];
    const ok = copyText(lines.join("\n"));
    this.statusEl.textContent = ok ? t("diagnosticCopied") : t("copyFailed");
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
