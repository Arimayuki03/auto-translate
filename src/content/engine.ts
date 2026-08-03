/** 页面翻译引擎：去重分批调度 / 状态 / 段落翻译 / 重试 / 还原（阶段 4 从 index.ts 抽出） */
import type { Settings } from "../shared/types";
import { buildUnitFromContainer, extractUnits } from "./extractor";
import type { ExtractOptions, TranslationUnit } from "./extractor";
import { Renderer } from "./renderer";
import { translateTexts } from "./translate";

const BATCH_UNITS = 20;
const BATCH_CHUNKS = 40;

export type EngineState = "off" | "translating" | "done" | "partial";

export interface EngineStats {
  done: number;
  error: number;
  total: number;
}

export class PageEngine {
  readonly renderer: Renderer;

  state: EngineState = "off";
  onStateChange?: (state: EngineState, stats: EngineStats) => void;

  private opts: ExtractOptions;
  private glossary: string[];
  private targetLang: string;
  private doneTexts = new Set<string>();
  private pendingTexts = new Set<string>();
  private allUnits: TranslationUnit[] = [];
  private stats: EngineStats = { done: 0, error: 0, total: 0 };

  constructor(renderer: Renderer, settings: Settings) {
    this.renderer = renderer;
    this.opts = {
      minTextLength: settings.translate.minTextLength,
      blockMaxChars: settings.translate.blockMaxChars,
      targetLang: settings.translate.targetLang,
    };
    this.targetLang = settings.translate.targetLang;
    this.glossary = settings.translate.terminology;

    // 失败重试：占位里的“重试”按钮
    document.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement | null)?.closest?.(".it-retry") as HTMLElement | null;
      if (!btn) return;
      const id = btn.getAttribute("data-it-unit");
      const unit = id ? this.allUnits.find((u) => u.id === id) : undefined;
      if (unit) this.retry(unit);
    });
  }

  get targetLanguage(): string {
    return this.targetLang;
  }

  get extractOptions(): ExtractOptions {
    return this.opts;
  }

  /** 目标语言切换（工具条） */
  setTargetLang(lang: string): void {
    this.targetLang = lang;
    this.opts = { ...this.opts, targetLang: lang };
  }

  /** 单条文本翻译（划词 / 输入框），失败 throw */
  async translateText(text: string): Promise<string> {
    const [r] = await translateTexts([text], this.targetLang, this.glossary);
    return r;
  }

  hasTranslated(): boolean {
    return this.stats.done > 0 || this.doneTexts.size > 0;
  }

  /** 该文本是否已处理（已译或在途），SPA / 段落按钮去重用 */
  isSkipped(text: string): boolean {
    return this.doneTexts.has(text) || this.pendingTexts.has(text);
  }

  /** 全页翻译：重新提取并翻译新增单元 */
  async translateAll(): Promise<void> {
    const units = extractUnits(document.body, this.opts).filter(
      (u) => !this.isSkipped(u.text) && !u.container.hasAttribute("data-it-src")
    );
    await this.translateUnits(units);
  }

  /** 段落级翻译：单个容器单独翻译 */
  async translateElement(el: HTMLElement): Promise<void> {
    const unit = buildUnitFromContainer(el, this.opts);
    if (unit) await this.translateUnits([unit]);
  }

  /** 一键还原 */
  restore(): void {
    this.renderer.restore();
    this.doneTexts.clear();
    this.pendingTexts.clear();
    this.allUnits = [];
    this.stats = { done: 0, error: 0, total: 0 };
    this.setState("off");
  }

  /** 供 SPA 观察器增量翻译 */
  async translateUnits(units: TranslationUnit[]): Promise<void> {
    if (units.length === 0) return;
    this.allUnits.push(...units);
    this.stats.total += units.length;
    this.setState("translating");

    const byText = new Map<string, TranslationUnit[]>();
    for (const u of units) {
      const list = byText.get(u.text) ?? [];
      list.push(u);
      byText.set(u.text, list);
    }

    let errored = 0;
    for (const batch of buildBatches([...byText.entries()])) {
      if (!(await this.translateBatch(batch))) {
        errored += batch.reduce((n, [, us]) => n + us.length, 0);
      }
    }
    this.setState(errored > 0 ? "partial" : "done");
  }

  private async translateBatch(batch: [string, TranslationUnit[]][]): Promise<boolean> {
    const involved = batch.flatMap(([, us]) => us);
    const batchTexts = batch.map(([text]) => text);
    for (const t of batchTexts) this.pendingTexts.add(t);

    const flat: { text: string; chunkText: string }[] = [];
    for (const [text, us] of batch) {
      for (const c of us[0].chunks) flat.push({ text, chunkText: c });
    }
    for (const u of involved) this.renderer.createPlaceholder(u);

    let results: string[];
    try {
      results = await translateTexts(flat.map((f) => f.chunkText), this.targetLang, this.glossary);
    } catch {
      for (const t of batchTexts) this.pendingTexts.delete(t);
      for (const u of involved) this.renderer.fail(u);
      this.stats.error += involved.length;
      this.emitStats();
      return false;
    }

    for (const t of batchTexts) {
      this.pendingTexts.delete(t);
      this.doneTexts.add(t);
    }

    // 同文单元共享译文；chunk 顺序与 flat 一致
    const textToChunks = new Map<string, string[]>();
    for (let i = 0; i < flat.length && i < results.length; i++) {
      let arr = textToChunks.get(flat[i].text);
      if (!arr) textToChunks.set(flat[i].text, (arr = []));
      arr.push(results[i] ?? "");
    }

    let filled = 0;
    for (const [text, us] of batch) {
      const chunks = textToChunks.get(text);
      if (!chunks) continue;
      for (const u of us) {
        this.renderer.fill(u, chunks);
        filled++;
      }
    }
    this.stats.done += filled;
    this.emitStats();
    return true;
  }

  /** 重试某个单元（连同共享文本的单元一起） */
  retry(unit: TranslationUnit): void {
    this.renderer.retryState(unit);
    const siblings = this.allUnits.filter((u) => u.text === unit.text);
    void this.translateUnits(siblings);
  }

  private setState(state: EngineState): void {
    this.state = state;
    this.onStateChange?.(state, this.stats);
  }

  private emitStats(): void {
    this.onStateChange?.(this.state, this.stats);
  }
}

/** 按“≤20 单元 / ≤40 chunk”分块，控制单次拼接的提示词体积 */
function buildBatches(entries: [string, TranslationUnit[]][]): [string, TranslationUnit[]][][] {
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
