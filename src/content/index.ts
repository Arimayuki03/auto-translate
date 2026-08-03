/** 阶段 3：全文翻译 MVP —— 入口 / 守卫 / 分批调度 / 最小浮动控制条 */
import type {
  TranslateRequestMessage,
  TranslateResponseMessage,
} from "../shared/messages";
import { getSettings } from "../shared/storage";
import type { DisplayMode, Settings } from "../shared/types";
import { extractUnits } from "./extractor";
import type { TranslationUnit } from "./extractor";
import { Renderer } from "./renderer";

/** 每批最多单元数 / 请求文本数（控制单次拼接的提示词体积） */
const BATCH_UNITS = 20;
const BATCH_CHUNKS = 40;

/** 敏感页面路径启发式（保守名单，命中即跳过自动翻译） */
const SENSITIVE_RE =
  /(login|log-?in|signin|sign-?in|signup|sign-?up|auth|bank|banking|pay|payment|checkout|secure|2fa|otp|password|wallet)/i;

let renderer: Renderer | null = null;
let allUnits: TranslationUnit[] = [];
let targetLang = "zh-CN";
let controlBar: ControlBar | null = null;
let msgSeq = 0;

async function main(): Promise<void> {
  const settings = await getSettings();
  if (!shouldTranslatePage(settings)) return;

  const units = extractUnits(document.body, {
    minTextLength: settings.translate.minTextLength,
    blockMaxChars: settings.translate.blockMaxChars,
    targetLang: settings.translate.targetLang,
  });
  if (units.length === 0) return;

  renderer = new Renderer(settings.translate.displayMode);
  renderer.setMode(settings.translate.displayMode);
  allUnits = units;
  targetLang = settings.translate.targetLang;
  controlBar = new ControlBar();

  await translateUnits(units, targetLang);
  controlBar.finish(units.length);
}

/** 页面级守卫：黑白名单 / 敏感页面 / 自动翻译开关 */
function shouldTranslatePage(s: Settings): boolean {
  if (!s.translate.autoTranslate) return false;
  const host = location.hostname.replace(/^www\./, "").toLowerCase();

  if (s.sites.blacklist.some((d) => host.includes(d.toLowerCase()))) return false;
  if (
    s.sites.whitelist.length > 0 &&
    !s.sites.whitelist.some(
      (d) => host === d.toLowerCase() || host.endsWith("." + d.toLowerCase())
    )
  ) {
    return false;
  }
  if (s.security.sensitivePages && SENSITIVE_RE.test(location.hostname + " " + location.pathname)) {
    return false;
  }
  return true;
}

/** 按文本去重后分批翻译，逐批渐进渲染 */
async function translateUnits(units: TranslationUnit[], lang: string): Promise<void> {
  const byText = new Map<string, TranslationUnit[]>();
  for (const u of units) {
    const list = byText.get(u.text) ?? [];
    list.push(u);
    byText.set(u.text, list);
  }

  for (const batch of buildBatches([...byText.entries()])) {
    await translateBatch(batch, lang);
    await sleep(80);
  }
}

function buildBatches(
  entries: [string, TranslationUnit[]][]
): [string, TranslationUnit[]][][] {
  const batches: [string, TranslationUnit[]][][] = [];
  let cur: [string, TranslationUnit[]][] = [];
  let curUnits = 0;
  let curChunks = 0;

  for (const e of entries) {
    const n = e[1].length;
    const c = e[1][0].chunks.length;
    if (cur.length > 0 && (curUnits + n > BATCH_UNITS || curChunks + c > BATCH_CHUNKS)) {
      batches.push(cur);
      cur = [];
      curUnits = 0;
      curChunks = 0;
    }
    cur.push(e);
    curUnits += n;
    curChunks += c;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

/** 单批：占位先行 → 发 background → 结果按 chunk 顺序回填到所有同文单元 */
async function translateBatch(
  batch: [string, TranslationUnit[]][],
  lang: string
): Promise<void> {
  const involved = batch.flatMap(([, us]) => us);
  const flat: { text: string; chunkText: string }[] = [];
  for (const [text, us] of batch) {
    for (const c of us[0].chunks) flat.push({ text, chunkText: c });
  }

  for (const u of involved) renderer!.createPlaceholder(u);

  const req: TranslateRequestMessage = {
    type: "translate",
    id: `ct-${Date.now()}-${++msgSeq}`,
    texts: flat.map((f) => f.chunkText),
    targetLang: lang,
  };

  let res: TranslateResponseMessage;
  try {
    res = (await chrome.runtime.sendMessage(req)) as TranslateResponseMessage;
  } catch {
    for (const u of involved) renderer!.fail(u);
    controlBar?.error(involved.length);
    return;
  }

  if (!res.ok || !res.results) {
    for (const u of involved) renderer!.fail(u);
    controlBar?.error(involved.length);
    return;
  }

  // 同文单元共享译文；chunk 顺序与 flat 一致
  const textToChunks = new Map<string, string[]>();
  for (let i = 0; i < flat.length && i < res.results.length; i++) {
    let arr = textToChunks.get(flat[i].text);
    if (!arr) textToChunks.set(flat[i].text, (arr = []));
    arr.push(res.results[i] ?? "");
  }

  for (const [text, us] of batch) {
    const chunks = textToChunks.get(text);
    if (!chunks) continue;
    for (const u of us) renderer!.fill(u, chunks);
  }
  controlBar?.progress(involved.length);
}

/** 最小浮动控制条：模式切换 / 还原 / 状态 / 收起 */
class ControlBar {
  private el: HTMLElement;
  private status: HTMLElement;
  private done = 0;
  private err = 0;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "it-control-bar";
    this.el.setAttribute("data-it-ui", "");

    const modeLabel = document.createElement("label");
    modeLabel.textContent = "模式 ";

    const select = document.createElement("select");
    select.className = "it-mode-select";
    for (const m of ["bilingual", "translated", "original"] as DisplayMode[]) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m === "bilingual" ? "双语对照" : m === "translated" ? "仅译文" : "原文";
      select.appendChild(opt);
    }
    select.value = renderer!.getMode();
    select.addEventListener("change", () => renderer!.setMode(select.value as DisplayMode));

    const restoreBtn = document.createElement("button");
    restoreBtn.textContent = "还原";
    restoreBtn.addEventListener("click", () => {
      renderer!.restore();
      this.el.remove();
    });

    this.status = document.createElement("span");
    this.status.className = "it-status";
    this.status.textContent = "翻译中…";

    const collapseBtn = document.createElement("button");
    collapseBtn.className = "it-collapse";
    collapseBtn.textContent = "收起";
    collapseBtn.addEventListener("click", () => this.el.classList.toggle("it-collapsed"));

    this.el.append(modeLabel, select, restoreBtn, this.status, collapseBtn);
    document.body.appendChild(this.el);
  }

  progress(n: number): void {
    this.done += n;
    this.status.textContent = `${this.done} 段完成`;
  }

  error(n: number): void {
    this.err += n;
    this.status.textContent = `${this.err} 段失败`;
  }

  finish(total: number): void {
    this.status.textContent = this.err
      ? `共 ${total} 段，${this.err} 段失败`
      : `共 ${total} 段完成`;
  }
}

/** 失败重试：点击占位里的“重试”按钮，重新入队该文本的所有单元 */
document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement | null;
  const btn = target?.closest?.(".it-retry") as HTMLElement | null;
  if (!btn) return;
  const id = btn.getAttribute("data-it-unit");
  const unit = id ? allUnits.find((u) => u.id === id) : undefined;
  if (!unit) return;
  const siblings = allUnits.filter((u) => u.text === unit.text);
  renderer?.retryState(unit);
  void translateUnits(siblings, targetLang);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main();
