/** 页面翻译引擎：视口优先 + 滚动懒翻译 / 去重分批 / 顺序渲染 / 段落翻译 / 重试 / 还原 */
import type { Settings } from "../shared/types";
import { extractUnits } from "./extractor";
import type { ExtractOptions, TranslationUnit } from "./extractor";
import { Renderer } from "./renderer";
import { translateTexts } from "./translate";
import { inViewport, partition } from "./ui";

const BATCH_UNITS = 12;
const BATCH_CHUNKS = 24;
/** 内容侧最多同时在途的批次请求数（后台另有 maxConcurrency 限流） */
const FETCH_WINDOW = 8;
/** 视口外提前多少 px 预译，滚动无感 */
const LAZY_MARGIN = 300;

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
  private viewportLazy: boolean;
  private doneTexts = new Set<string>();
  private pendingTexts = new Set<string>();
  private allUnits: TranslationUnit[] = [];
  private stats: EngineStats = { done: 0, error: 0, total: 0 };

  // 视口懒翻译状态
  private pendingCount = 0;
  private lazyIO: IntersectionObserver | null = null;
  private lazyUnits = new Map<Element, TranslationUnit>();
  private lazyPending: TranslationUnit[] = [];
  private lazyTimer: number | undefined;

  constructor(renderer: Renderer, settings: Settings) {
    this.renderer = renderer;
    this.opts = {
      minTextLength: settings.translate.minTextLength,
      blockMaxChars: settings.translate.blockMaxChars,
      targetLang: settings.translate.targetLang,
    };
    this.targetLang = settings.translate.targetLang;
    this.glossary = settings.translate.terminology;
    this.viewportLazy = settings.translate.viewportLazy;

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

  /** 全页翻译：提取新增单元，视口内先译，视口外进入时再译 */
  async translateAll(): Promise<void> {
    const units = extractUnits(document.body, this.opts).filter(
      (u) =>
        !u.container.hasAttribute("data-it-src") &&
        !u.container.hasAttribute("data-it-processing")
    );
    this.scheduleUnits(units);
  }

  /** 一键还原 */
  restore(): void {
    this.renderer.restore();
    this.doneTexts.clear();
    this.pendingTexts.clear();
    this.allUnits = [];
    this.stats = { done: 0, error: 0, total: 0 };
    this.pendingCount = 0;
    this.lazyIO?.disconnect();
    this.lazyIO = null;
    this.lazyUnits.clear();
    this.lazyPending = [];
    clearTimeout(this.lazyTimer);
    this.setState("off");
  }

  /**
   * 调度翻译：按文本去重 → 视口内先译 → 视口外注册 IntersectionObserver 滚动再译。
   * 自动翻译 / SPA 新增 / 重试 都走这里 —— 只翻译正在看的内容，不一次性翻整页。
   */
  scheduleUnits(units: TranslationUnit[]): void {
    // 只调度“新鲜”单元：已译 / 在途 / 已在懒观察中 的不重复入队
    const fresh = units.filter(
      (u) =>
        !this.lazyUnits.has(u.container) &&
        !u.container.hasAttribute("data-it-src") &&
        !u.container.hasAttribute("data-it-processing")
    );
    if (fresh.length === 0) return;
    this.pendingCount += fresh.length;
    this.stats.total += fresh.length;
    if (this.viewportLazy) {
      // 视口懒翻译：视口内先译，视口外进入时再译（省 token）
      const [visible, hidden] = partition(fresh, (u) => inViewport(u.container));
      if (visible.length > 0) void this.translateUnits(visible);
      if (hidden.length > 0) this.observeLazy(hidden);
    } else {
      // 关闭懒翻译：一次性全部翻译
      void this.translateUnits(fresh);
    }
  }

  private observeLazy(units: TranslationUnit[]): void {
    this.lazyIO ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const u = this.lazyUnits.get(entry.target);
          if (!u) continue;
          this.lazyIO!.unobserve(entry.target);
          this.lazyUnits.delete(entry.target);
          if (
            !u.container.hasAttribute("data-it-src") &&
            !u.container.hasAttribute("data-it-processing")
          ) {
            this.lazyPending.push(u);
          }
        }
        this.flushLazy();
      },
      { rootMargin: `${LAZY_MARGIN}px 0px` }
    );
    for (const u of units) {
      this.lazyUnits.set(u.container, u);
      this.lazyIO.observe(u.container);
    }
  }

  private flushLazy(): void {
    clearTimeout(this.lazyTimer);
    this.lazyTimer = window.setTimeout(() => {
      const group = this.lazyPending.splice(0);
      this.lazyPending = [];
      if (group.length > 0) void this.translateUnits(group);
    }, 60);
  }

  /** 处理一组单元：预留空间 → 标记在途 → 去重分批 → 并发请求 → 按序渲染 */
  async translateUnits(units: TranslationUnit[]): Promise<void> {
    if (units.length === 0) return;
    const anchor = this.captureAnchor();
    for (const u of units) u.container.setAttribute("data-it-processing", "");
    // 预留译文空间（不可见占位），填充在原位，避免页面跳动
    for (const u of units) this.renderer.reserve(u);
    this.releaseScroll(anchor);
    this.allUnits.push(...units);
    this.setState("translating");

    const byText = new Map<string, TranslationUnit[]>();
    for (const u of units) {
      const list = byText.get(u.text) ?? [];
      list.push(u);
      byText.set(u.text, list);
    }
    const batches = buildBatches([...byText.entries()]);

    // 顶部优先：请求并发发起（后台统一限流），渲染严格按批次顺序 → 页头先出
    const fetchMap = new Map<number, Promise<Map<string, string[]> | null>>();
    for (let i = 0; i < batches.length; i++) {
      for (let j = i; j < Math.min(batches.length, i + FETCH_WINDOW); j++) {
        if (!fetchMap.has(j)) fetchMap.set(j, this.fetchBatch(batches[j]));
      }
      const chunks = await fetchMap.get(i)!;
      fetchMap.delete(i);
      if (chunks) {
        this.renderBatch(batches[i], chunks);
      } else {
        const failed = batches[i].flatMap(([, us]) => us);
        this.stats.error += failed.length;
        for (const u of failed) {
          this.renderer.fail(u);
          u.container.removeAttribute("data-it-processing");
        }
      }
    }

    this.pendingCount = Math.max(0, this.pendingCount - units.length);
    this.afterGroup();
  }

  /** 完成一组后的状态推进：还有待译保持 translating，全部完成则 done/partial */
  private afterGroup(): void {
    if (this.pendingCount > 0 || this.lazyUnits.size > 0) {
      this.setState("translating");
    } else {
      this.setState(this.stats.error > 0 ? "partial" : "done");
    }
  }

  /** 发起一批请求：只请求、不渲染；成功返回 文本→译文chunks，失败返回 null */
  private async fetchBatch(
    batch: [string, TranslationUnit[]][]
  ): Promise<Map<string, string[]> | null> {
    const batchTexts = batch.map(([text]) => text);
    for (const t of batchTexts) this.pendingTexts.add(t);

    const flat: { text: string; chunkText: string }[] = [];
    for (const [text, us] of batch) {
      for (const c of us[0].chunks) flat.push({ text, chunkText: c });
    }

    let results: string[];
    try {
      results = await translateTexts(flat.map((f) => f.chunkText), this.targetLang, this.glossary);
    } catch {
      for (const t of batchTexts) this.pendingTexts.delete(t);
      return null;
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
    return textToChunks;
  }

  /** 按序渲染一批：译文或失败标记（必须按批次顺序调用，保证顶部先出） */
  private renderBatch(
    batch: [string, TranslationUnit[]][],
    textToChunks: Map<string, string[]>
  ): void {
    let filled = 0;
    for (const [text, us] of batch) {
      const chunks = textToChunks.get(text);
      for (const u of us) {
        u.container.removeAttribute("data-it-processing");
        if (chunks && chunks.length > 0) {
          this.renderer.fill(u, chunks);
          filled++;
        } else {
          this.renderer.fail(u);
        }
      }
    }
    this.stats.done += filled;
    this.emitStats();
  }

  /** 重试某个单元（连同共享文本的单元一起） */
  retry(unit: TranslationUnit): void {
    this.renderer.retryState(unit);
    const siblings = this.allUnits.filter((u) => u.text === unit.text);
    this.scheduleUnits(siblings);
  }

  /** 捕获滚动锚点：视口顶部附近的元素及其视口相对位置 */
  private captureAnchor(): { el: Element; top: number } | null {
    const el = document.elementFromPoint(innerWidth / 2, Math.min(60, innerHeight / 3));
    if (!(el instanceof Element)) return null;
    return { el, top: el.getBoundingClientRect().top };
  }

  /** 预留空间后补偿滚动，把锚点元素拉回原位置，避免页面自动移动 */
  private releaseScroll(anchor: { el: Element; top: number } | null): void {
    if (!anchor || !anchor.el.isConnected) return;
    const delta = anchor.el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 1) window.scrollBy(0, delta);
  }

  private setState(state: EngineState): void {
    this.state = state;
    this.onStateChange?.(state, this.stats);
  }

  private emitStats(): void {
    this.onStateChange?.(this.state, this.stats);
  }
}

/** 按“≤BATCH_UNITS 单元 / ≤BATCH_CHUNKS chunk”分块，控制单次拼接的提示词体积 */
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
