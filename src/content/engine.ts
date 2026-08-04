/** 页面翻译引擎：视口优先 + 滚动懒翻译 / 去重分批 / 顺序渲染 / 段落翻译 / 重试 / 还原 */
import type { CheckCacheMessage } from "../shared/messages";
import type { Settings } from "../shared/types";
import { extractUnits, isTargetLanguage } from "./extractor";
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
  /** 代次：restore 后 +1，在途翻译结果作废，防止还原后译文又冒出来 */
  private generation = 0;
  /** 用户是否手动还原过本页（点「还原」）：自动翻译不应再把本页译回来 */
  private userRestored = false;

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

  /** 用户是否手动还原过本页（自动翻译切回前台时不该再译回来） */
  get restoredByUser(): boolean {
    return this.userRestored;
  }

  /** 该文本是否已处理（已译或在途），SPA / 段落按钮去重用 */
  isSkipped(text: string): boolean {
    return this.doneTexts.has(text) || this.pendingTexts.has(text);
  }

  /** 全页翻译：提取新增单元，视口内先译，视口外进入时再译 */
  async translateAll(): Promise<void> {
    this.userRestored = false; // 主动翻译即代表用户想翻译，重置还原标记
    const gen = this.generation;
    const units = extractUnits(document.body, this.opts).filter(
      (u) =>
        !u.container.hasAttribute("data-it-src") &&
        !u.container.hasAttribute("data-it-processing")
    );
    if (units.length === 0) {
      void this.translatePlaceholders();
      return;
    }
    // 页面大部分内容已有缓存（之前翻过）→ 整页直译；否则视口懒翻译省 token
    const cachedRatio = await this.checkPageCacheRatio(units);
    if (gen !== this.generation) return; // 等待期间被还原，放弃本次
    this.scheduleUnits(units, cachedRatio >= 0.6);
    void this.translatePlaceholders();
  }

  /** 抽样判断页面缓存命中率（有缓存则整页直译，无需懒翻译） */
  private async checkPageCacheRatio(units: TranslationUnit[]): Promise<number> {
    const texts = [...new Set(units.map((u) => u.text))];
    const sample = texts.slice(0, 40);
    if (sample.length === 0) return 0;
    try {
      const res = (await chrome.runtime.sendMessage({
        type: "check-cache",
        targetLang: this.targetLang,
        texts: sample,
      } as CheckCacheMessage)) as { cachedCount?: number };
      return (res?.cachedCount ?? 0) / sample.length;
    } catch {
      return 0;
    }
  }

  /** 翻译搜索框/输入框的 placeholder 提示词（去重 + 术语表 + 防重复） */
  async translatePlaceholders(): Promise<void> {
    const gen = this.generation;
    const els = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[placeholder], textarea[placeholder]'
      )
    ).filter(
      (el) =>
        el.placeholder.trim() !== "" &&
        !el.hasAttribute("data-it-ph-done") &&
        isTranslatablePlaceholder(el.placeholder, this.targetLang)
    );
    if (els.length === 0) return;

    const byText = new Map<string, (HTMLInputElement | HTMLTextAreaElement)[]>();
    for (const el of els) {
      const list = byText.get(el.placeholder) ?? [];
      list.push(el);
      byText.set(el.placeholder, list);
    }
    const texts = [...byText.keys()];

    let results: string[];
    try {
      results = await translateTexts(texts, this.targetLang, this.glossary);
    } catch {
      return;
    }
    if (gen !== this.generation) return; // 期间被还原，放弃

    for (let i = 0; i < texts.length && i < results.length; i++) {
      const t = results[i]?.trim();
      if (!t) continue;
      for (const el of byText.get(texts[i]) ?? []) {
        if (!el.hasAttribute("data-it-ph-orig")) {
          el.setAttribute("data-it-ph-orig", texts[i]);
        }
        el.placeholder = t;
        el.setAttribute("data-it-ph-done", "");
      }
    }
  }

  /** 还原 placeholder 提示词到原文 */
  private restorePlaceholders(): void {
    document
      .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-it-ph-done]")
      .forEach((el) => {
        const orig = el.getAttribute("data-it-ph-orig");
        if (orig !== null) el.placeholder = orig;
        el.removeAttribute("data-it-ph-orig");
        el.removeAttribute("data-it-ph-done");
      });
  }

  /**
   * SPA 整体换页（<body> 被替换）：作废在途请求、清空旧页缓存与渲染状态。
   * 不置 state 为 off —— 换页后仍需按自动翻译/观察器语义继续译新内容。
   */
  resetForNavigation(): void {
    this.generation++; // 在途翻译结果作废（旧页容器已脱离文档）
    this.renderer.restore();
    this.restorePlaceholders(); // SPA 换页后重置 placeholder，避免旧译文残留
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
  }

  /** 一键还原 */
  restore(): void {
    this.userRestored = true; // 用户明确还原，自动翻译不再把本页译回来
    this.generation++; // 在途翻译结果作废
    this.renderer.restore();
    this.restorePlaceholders();
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
  scheduleUnits(units: TranslationUnit[], forceFull = false): void {
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
    if (forceFull || !this.viewportLazy) {
      // 有缓存（整页直译）或关闭懒翻译：一次性全部翻译
      void this.translateUnits(fresh);
    } else {
      // 视口懒翻译：视口内先译，视口外进入时再译（省 token）
      const [visible, hidden] = partition(fresh, (u) => inViewport(u.container));
      if (visible.length > 0) void this.translateUnits(visible);
      if (hidden.length > 0) this.observeLazy(hidden);
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
    const gen = this.generation; // 捕获本批代次
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
      if (gen !== this.generation) return; // 期间被还原，丢弃后续结果
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

  /** 完成一组后的状态推进：按结果标记完成/部分失败
   * （不再因视口外懒翻译未译而卡在 translating，否则工具条“还原”按钮会被永久禁用） */
  private afterGroup(): void {
    this.setState(this.stats.error > 0 ? "partial" : "done");
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
    let failed = 0;
    for (const [text, us] of batch) {
      const chunks = textToChunks.get(text);
      for (const u of us) {
        u.container.removeAttribute("data-it-processing");
        if (chunks && chunks.length > 0) {
          this.renderer.fill(u, chunks);
          filled++;
        } else {
          this.renderer.fail(u);
          failed++;
        }
      }
    }
    this.stats.done += filled;
    this.stats.error += failed;
    this.emitStats();
  }

  /** 重试某个单元（连同共享文本、同为失败态的兄弟单元一起） */
  retry(unit: TranslationUnit): void {
    const siblings = this.allUnits.filter((u) => u.text === unit.text);
    const toRetry = siblings.filter((s) => s === unit || this.renderer.isFailed(s.container));
    for (const s of toRetry) this.renderer.retryState(s);
    this.scheduleUnits(toRetry);
  }

  /** 捕获滚动锚点：视口顶部附近的元素及其视口相对位置 */
  private captureAnchor(): { el: Element; top: number } | null {
    try {
      const el = document.elementFromPoint(innerWidth / 2, Math.min(60, innerHeight / 3));
      if (!(el instanceof Element)) return null;
      return { el, top: el.getBoundingClientRect().top };
    } catch {
      return null; // 个别环境未实现 elementFromPoint，忽略滚动锚点即可
    }
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

/** placeholder 提示词是否值得翻译：够长、含字母、且不是目标语言 */
function isTranslatablePlaceholder(text: string, targetLang: string): boolean {
  if (text.length < 2) return false;
  if (!/[A-Za-zÀ-ɏ぀-ヿ가-힣一-鿿]/.test(text)) return false;
  return !isTargetLanguage(text, targetLang);
}
