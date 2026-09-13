/** 页面翻译引擎：视口优先 + 滚动懒翻译 / 去重分批 / 顺序渲染 / 段落翻译 / 重试 / 还原 */
import type {
  CancelTranslationMessage,
  CheckCacheMessage,
  TranslationContext,
} from "../shared/messages";
import type { Settings } from "../shared/types";
import { extractUnits, extractUnitsChunked, isTargetLanguage, EXCLUDED_TAGS, LETTER_RE } from "./extractor";
import type { ExtractOptions, TranslationUnit } from "./extractor";
import { precomputeStyles, Renderer } from "./renderer";
import { createWorkPacer, pauseIfBudgetSpent } from "./scheduler";
import { translateTexts, TranslateError } from "./translate";
import { inViewport, partition } from "./ui";

// 批量大小（省 token 关键）：每个请求都重复携带"系统提示词 + 整页上下文"，
// 批量越大 → 请求数越少 → 这份重复开销越小。参照"拼成一大段一次发"的思路调大。
// 即使某批因超出模型输出上限被截断、解析失败而降级逐段，后台请求限速也会钳制并发，
// 不会因此爆并发（见 TranslateService 限速）。
const BATCH_UNITS = 30;
const BATCH_CHUNKS = 60;
/** 内容侧最多同时在途的批次请求数（后台另有 maxConcurrency + 请求启动限速） */
const FETCH_WINDOW = 4;
/** 视口外提前多少 px 预译，滚动无感 */
const LAZY_MARGIN = 300;
/** allUnits / doneTexts 软上限：长会话不膨胀（SPA 不换页时持续累积） */
const MAX_UNITS = 5000;
const MAX_DONE_TEXTS = 10000;

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
  /** 页面上下文（标题/描述/正文摘要）仅整页翻译注入，可在设置里关闭或限制长度 */
  private contextEnabled: boolean;
  private contextMaxChars: number;
  /** HTML 属性翻译开关（placeholder / title / alt / aria-label） */
  private attributesEnabled: boolean;
  private pageContext: TranslationContext | undefined;
  /** 防止自动翻译/可见性/SPA 信号同时触发时重复扫描并重复计数 */
  private translateAllRunning = false;
  private translateAllQueued = false;
  /** 悬停单元素翻译期间钳制整页状态机：观察器与自动翻译都以 state === "off" 判定
   *  “整页未翻译”，若单译把 state 推到 translating/done，下一次点击兜底扫描或动态内容
   *  变化就会经观察器把整页补译掉，破坏“只译该段”语义。translateAll / restore /
   *  resetForNavigation 会解除钳制，真正的整页动作不受影响。 */
  private suppressPageState = false;
  private doneTexts = new Set<string>();
  private pendingTexts = new Set<string>();
  /** 所有已调度单元（按 id 索引，O(1) 查找代替数组 find） */
  private allUnits = new Map<string, TranslationUnit>();
  /** 文本 → 共享该文本的单元列表（retry 时 O(1) 查找兄弟单元） */
  private unitsByText = new Map<string, TranslationUnit[]>();
  private stats: EngineStats = { done: 0, error: 0, total: 0 };

  // 视口懒翻译状态
  private pendingCount = 0;
  private lazyIO: IntersectionObserver | null = null;
  private lazyUnits = new Map<Element, TranslationUnit>();
  private scheduledContainers = new Set<HTMLElement>();
  private lazyPending: TranslationUnit[] = [];
  private lazyTimer: number | undefined;
  /** 代次：restore 后 +1，在途翻译结果作废，防止还原后译文又冒出来 */
  private generation = 0;
  /** 用户是否手动还原过本页（点「还原」）：自动翻译不应再把本页译回来 */
  private userRestored = false;
  /** 最近一次翻译失败的错误（带类型与脱敏诊断）：工具条显示具体原因、可复制诊断 */
  lastError?: TranslateError;

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
    this.contextEnabled = settings.translate.contextEnabled ?? true;
    this.contextMaxChars = Math.max(200, settings.translate.contextMaxChars ?? 3000);
    this.attributesEnabled = settings.translate.translateAttributes ?? true;
    this.pageContext = undefined;

    // 失败重试：占位里的“重试”按钮
    document.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement | null)?.closest?.(".it-retry") as HTMLElement | null;
      if (!btn) return;
      const id = btn.getAttribute("data-it-unit");
      const unit = id ? this.allUnits.get(id) : undefined;
      // 控件（按钮/选项）失败时保留原文、无可见重试入口：拦截残留的 data-it-unit 误触
      if (unit && !unit.textOnly) this.retry(unit);
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
    this.renderer.setTargetLang(lang); // 占位估算/chunk 分隔按新语言渲染
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

  /** 该容器是否已在调度/懒观察队列中（观察器补扫去重用） */
  isScheduled(container: HTMLElement): boolean {
    return this.scheduledContainers.has(container) || this.lazyUnits.has(container);
  }

  /** 全页翻译：提取新增单元，视口内先译，视口外进入时再译 */
  async translateAll(): Promise<void> {
    if (this.translateAllRunning) {
      this.translateAllQueued = true;
      return;
    }
    this.translateAllRunning = true;
    this.userRestored = false; // 主动翻译即代表用户想翻译，重置还原标记
    this.suppressPageState = false; // 整页翻译解除悬停单译的状态钳制
    this.lastError = undefined; // 新一轮翻译开始，清掉上一轮的失败信息
    try {
      const gen = this.generation;
      this.pageContext = this.contextEnabled ? getPageContext(this.contextMaxChars) : undefined;
      // 全页扫描用时间片版提取：超大页面不再一次性阻塞主线程（借鉴 read-frog chunked walk）。
      // 让出期间若被还原（generation 变化）则中止本次。
      const extracted = await extractUnitsChunked(
        document.body,
        this.opts,
        () => gen === this.generation
      );
      if (gen !== this.generation) return;
      const units = extracted.filter(
        (u) =>
          !u.container.hasAttribute("data-it-src") &&
          !u.container.hasAttribute("data-it-processing") &&
          !this.renderer.isFailed(u.container) && // 失败容器走占位里的「重试」，重复扫描只会膨胀 total
          !this.lazyUnits.has(u.container) &&
          !this.scheduledContainers.has(u.container) &&
          !this.pendingTexts.has(u.text) &&
          !this.doneTexts.has(u.text)
      );
      if (units.length === 0) {
        void this.translateAttributes();
        return;
      }
      // 页面大部分内容已有缓存（之前翻过）→ 整页直译；否则视口懒翻译省 token
      const cachedRatio = await this.checkPageCacheRatio(units);
      if (gen !== this.generation) return; // 等待期间被还原，放弃本次
      this.scheduleUnits(units, cachedRatio >= 0.6);
      void this.translateAttributes();
    } finally {
      this.translateAllRunning = false;
      if (this.translateAllQueued) {
        this.translateAllQueued = false;
        void this.translateAll();
      }
    }
  }

  /**
   * 单元素翻译（悬停翻译入口）：以该元素为根做一次块级提取，走与整页/观察器完全相同的
   * 调度与去重口径（data-it-src / data-it-processing / isFailed / 懒观察 / 在途与已译文本）。
   * 同步提取无 await，代次校验由 translateUnits 内部兜底（调度后还原/换页即在途作废）。
   * 整页未动时钳制状态机（suppressPageState）：只译该段不应让下一次点击/动态变化把整页补译掉。
   */
  translateElement(el: Element): void {
    if (!(el instanceof HTMLElement) || !el.isConnected) return;
    const units = extractUnits(el, this.opts).filter(
      (u) =>
        !u.container.hasAttribute("data-it-src") &&
        !u.container.hasAttribute("data-it-processing") &&
        !this.renderer.isFailed(u.container) &&
        !this.lazyUnits.has(u.container) &&
        !this.scheduledContainers.has(u.container) &&
        !this.pendingTexts.has(u.text) &&
        !this.doneTexts.has(u.text)
    );
    if (units.length === 0) return;
    // 只在整页确实未动时钳制：translateAll 进行中或已译状态下走常规状态机，
    // 避免与在途整页翻译竞争时把状态永久卡在 translating
    if (this.state === "off" && !this.translateAllRunning) this.suppressPageState = true;
    this.scheduleUnits(units);
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

  /** 翻译页面属性文案（placeholder / title / alt / aria-label）：去重 + 术语表 + 防重复 */
  async translateAttributes(): Promise<void> {
    if (!this.attributesEnabled) return;
    const gen = this.generation;
    // 一次性收集全部可译属性候选，按文本去重后一次批译（与 placeholder 管线同思路）
    const candidates: Array<{ el: HTMLElement; attr: TranslatableAttr; text: string }> = [];
    for (const attr of TRANSLATABLE_ATTRS) {
      const sel =
        attr === "placeholder" ? "input[placeholder], textarea[placeholder]" : `[${attr}]`;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        if (candidates.length >= MAX_ATTR_CANDIDATES) break;
        if (el.hasAttribute("data-it-attr-done")) continue;
        if (!isTranslatableAttrElement(el, attr)) continue;
        const text = (el.getAttribute(attr) ?? "").trim();
        if (!text || text.length > MAX_ATTR_TEXT) continue;
        if (!isTranslatableAttrText(text, this.targetLang)) continue;
        candidates.push({ el, attr, text });
      }
      if (candidates.length >= MAX_ATTR_CANDIDATES) break;
    }
    if (candidates.length === 0) return;

    const byText = new Map<string, Array<{ el: HTMLElement; attr: TranslatableAttr }>>();
    for (const c of candidates) {
      const list = byText.get(c.text) ?? [];
      list.push({ el: c.el, attr: c.attr });
      byText.set(c.text, list);
    }
    const texts = [...byText.keys()];

    let results: string[];
    try {
      results = await translateTexts(texts, this.targetLang, this.glossary);
    } catch {
      return; // 属性翻译失败不阻塞正文翻译，也无需报错占位
    }
    if (gen !== this.generation) return; // 期间被还原，放弃

    for (let i = 0; i < texts.length && i < results.length; i++) {
      const t = results[i]?.trim();
      if (!t) continue;
      for (const { el, attr } of byText.get(texts[i]) ?? []) {
        saveOriginalAttr(el, attr);
        el.setAttribute(attr, t);
        el.setAttribute("data-it-attr-done", "");
      }
    }
  }

  /** 还原全部已译属性到原文（含旧版 placeholder 专用标记的兼容清理） */
  private restoreAttributes(): void {
    document.querySelectorAll<HTMLElement>("[data-it-attr-done]").forEach((el) => {
      const raw = el.getAttribute("data-it-attr-orig");
      if (raw) {
        try {
          const saved = JSON.parse(raw) as Record<string, string>;
          for (const [attr, value] of Object.entries(saved)) el.setAttribute(attr, value);
        } catch {
          // 坏 JSON：保持译文态即可，还原流程不应中断
        }
      }
      el.removeAttribute("data-it-attr-orig");
      el.removeAttribute("data-it-attr-done");
    });
    // 兼容旧版 placeholder 专用标记（升级当刻未刷新页面的残留）
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-it-ph-done]").forEach(
      (el) => {
        const orig = el.getAttribute("data-it-ph-orig");
        if (orig !== null) el.placeholder = orig;
        el.removeAttribute("data-it-ph-orig");
        el.removeAttribute("data-it-ph-done");
      }
    );
  }

  /** 清理在途批次残留在容器上的处理标记：还原/换页时在途批次的 renderBatch 永远不会执行，
   *  若不清理，这些容器会被 translateAll / 观察器的去重口径永久跳过（F-2）。 */
  private clearProcessingMarks(): void {
    document.querySelectorAll("[data-it-processing]").forEach((el) => {
      el.removeAttribute("data-it-processing");
    });
  }

  /**
   * SPA 整体换页（<body> 被替换）：作废在途请求、清空旧页缓存与渲染状态。
   * 不置 state 为 off —— 换页后仍需按自动翻译/观察器语义继续译新内容。
   */
  resetForNavigation(): void {
    this.suppressPageState = false; // 换页后按新页面语义重新开始
    this.cancelSession(this.generation); // SPA 换页：中止旧页在途请求
    this.generation++; // 在途翻译结果作废（旧页容器已脱离文档）
    this.renderer.restore();
    this.clearProcessingMarks();
    this.restoreAttributes(); // SPA 换页后重置 placeholder，避免旧译文残留
    // 旧页上下文作废：换页后若观察器先于 translateAll 触发翻译，不能把旧页的
    // 标题/摘要当作新页语境注入（下次 translateAll 会按新页重新计算）
    this.pageContext = undefined;
    this.doneTexts.clear();
    this.pendingTexts.clear();
    this.allUnits.clear();
    this.unitsByText.clear();
    this.stats = { done: 0, error: 0, total: 0 };
    this.pendingCount = 0;
    this.translateAllQueued = false;
    this.lazyIO?.disconnect();
    this.lazyIO = null;
    this.lazyUnits.clear();
    this.scheduledContainers.clear();
    this.lazyPending = [];
    clearTimeout(this.lazyTimer);
  }

  /** 一键还原 */
  restore(): void {
    this.userRestored = true; // 用户明确还原，自动翻译不再把本页译回来
    this.suppressPageState = false; // 解除悬停单译的状态钳制
    this.cancelSession(this.generation); // 中止当前会话在途请求，不浪费额度/算力
    this.generation++; // 在途翻译结果作废
    this.renderer.restore();
    this.clearProcessingMarks();
    this.restoreAttributes();
    this.doneTexts.clear();
    this.pendingTexts.clear();
    this.allUnits.clear();
    this.unitsByText.clear();
    this.stats = { done: 0, error: 0, total: 0 };
    this.pendingCount = 0;
    this.translateAllQueued = false;
    this.lazyIO?.disconnect();
    this.lazyIO = null;
    this.lazyUnits.clear();
    this.scheduledContainers.clear();
    this.lazyPending = [];
    clearTimeout(this.lazyTimer);
    this.setState("off");
  }

  /** 中止某会话的在途翻译请求（还原/换页时）：background 按 sessionId 批量 abort。
   *  发送失败无碍——generation 递增已保证作废结果，这里只是尽力省下后台开销。 */
  private cancelSession(sessionId: number): void {
    const msg: CancelTranslationMessage = { type: "cancel-translation", sessionId };
    chrome.runtime.sendMessage(msg).catch(() => undefined);
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
        !this.scheduledContainers.has(u.container) &&
        !u.container.hasAttribute("data-it-src") &&
        !u.container.hasAttribute("data-it-processing")
    );
    if (fresh.length === 0) return;
    for (const u of fresh) this.scheduledContainers.add(u.container);
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
        let queued = 0;
        for (const entry of entries) {
          // 关键修复：IntersectionObserver 首次回调会把所有被观察目标都派发为 entries
          // （含未进视口的，isIntersecting=false）。必须只处理真正进入视口的，
          // 否则屏幕外几百个单元会被一次性全量翻译 → 大页面卡死。
          if (!entry.isIntersecting) continue;
          const u = this.lazyUnits.get(entry.target);
          if (!u) continue;
          this.lazyIO!.unobserve(entry.target);
          this.lazyUnits.delete(entry.target);
          if (
            !u.container.hasAttribute("data-it-src") &&
            !u.container.hasAttribute("data-it-processing")
          ) {
            this.lazyPending.push(u);
            queued++;
          }
        }
        if (queued > 0) this.flushLazy();
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
    for (const u of units) this.scheduledContainers.delete(u.container);
    const gen = this.generation; // 捕获本批代次
    const anchor = this.captureAnchor();
    for (const u of units) u.container.setAttribute("data-it-processing", "");
    // 预留译文空间（不可见占位），填充在原位，避免页面跳动。
    // 性能要点（大页面卡顿修复）：
    //  1) 先一次性预读所有容器的样式（getComputedStyle/clientWidth），此时尚无
    //     结构性 DOM 写入，只触发一次重排；
    //  2) 占位插入阶段直接用预读值，循环里不再读几何/样式属性；
    //  3) 占位插入按时间片配速（每 12ms 让出主线程），大页面几十次 DOM 插入不再堆在
    //     一个同步任务里冻结页面；每次让出后校验代次，还原即中止。
    const pacer = createWorkPacer();
    const styleMap = precomputeStyles(units);
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      this.renderer.reserve(u, styleMap.get(u.container));
      await pauseIfBudgetSpent(pacer);
      if (gen !== this.generation) return; // 让出期间被还原 → 中止，不再继续占位/请求
    }
    this.releaseScroll(anchor);
    // 索引登记：allUnits（按 id）+ unitsByText（按文本，retry 用）
    for (const u of units) {
      if (this.allUnits.size < MAX_UNITS) {
        this.allUnits.set(u.id, u);
        let list = this.unitsByText.get(u.text);
        if (!list) this.unitsByText.set(u.text, (list = []));
        list.push(u);
      }
    }
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
        await this.renderBatch(batches[i], chunks, gen, pacer);
      } else {
        const failed = batches[i].flatMap(([, us]) => us);
        this.stats.error += failed.length;
        for (const u of failed) {
          this.renderer.fail(u);
          u.container.removeAttribute("data-it-processing");
        }
      }
      if (gen !== this.generation) return;
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
    const session = this.generation; // 会话 id：还原/换页时 background 据此中止在途请求
    const batchTexts = batch.map(([text]) => text);
    for (const t of batchTexts) this.pendingTexts.add(t);

    const flat: { text: string; chunkText: string }[] = [];
    for (const [text, us] of batch) {
      for (const c of us[0].chunks) flat.push({ text, chunkText: c });
    }

    let results: string[];
    try {
      results = await translateTexts(
        flat.map((f) => f.chunkText),
        this.targetLang,
        this.glossary,
        this.pageContext,
        session
      );
    } catch (err) {
      // 记下带类型/诊断的错误，供工具条展示具体失败原因（如「主 API 鉴权失败」）。
      // 会话中止（cancelled）是预期行为，不记为失败。
      if (err instanceof TranslateError) this.lastError = err;
      for (const t of batchTexts) this.pendingTexts.delete(t);
      return null;
    }

    // 会话在请求期间被还原/换页：结果作废。绝不能把文本写进 doneTexts——
    // 否则重新翻译时这些段落会被去重口径跳过，刷新页面前永远拿不到译文（F-2）。
    if (session !== this.generation) {
      for (const t of batchTexts) this.pendingTexts.delete(t);
      return null;
    }

    // 全部段落返回空串（后台对部分失败静默返回 ""）→ 视为失败，避免渲染空译文
    if (results.every((r) => !r?.trim())) {
      for (const t of batchTexts) this.pendingTexts.delete(t);
      return null;
    }

    for (const t of batchTexts) {
      this.pendingTexts.delete(t);
      if (this.doneTexts.size < MAX_DONE_TEXTS) this.doneTexts.add(t);
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

  /** 按序渲染一批：译文或失败标记（必须按批次顺序调用，保证顶部先出）。
   *  按时间片配速：填充是 DOM 写入密集操作，大页面一批十几个节点的插入/改写
   *  不再堆在一个同步任务里，每 12ms 让出主线程；让出后校验代次，还原即中止。 */
  private async renderBatch(
    batch: [string, TranslationUnit[]][],
    textToChunks: Map<string, string[]>,
    gen: number,
    pacer: { deadline: number; budgetMs: number }
  ): Promise<void> {
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
        await pauseIfBudgetSpent(pacer);
        if (gen !== this.generation) {
          this.stats.done += filled;
          this.stats.error += failed;
          this.emitStats();
          return; // 让出期间被还原 → 中止后续填充
        }
      }
    }
    this.stats.done += filled;
    this.stats.error += failed;
    this.emitStats();
  }

  /** 重试某个单元（连同共享文本、同为失败态的兄弟单元一起） */
  retry(unit: TranslationUnit): void {
    const siblings = this.unitsByText.get(unit.text) ?? [unit];
    const toRetry = siblings.filter((s) => s === unit || this.renderer.isFailed(s.container));
    for (const s of toRetry) this.renderer.retryState(s);
    // 重试单元在首次调度时已计入 total，scheduleUnits 会再加一次，先抵扣避免统计膨胀
    this.stats.total -= toRetry.length;
    this.scheduleUnits(toRetry);
  }

  /** 捕获滚动锚点：记录当前滚动位置，预留空间后补偿回来避免页面跳动。
   *  不用 elementFromPoint（命中测试在大页面代价高），改用纯 scrollY 计算。 */
  private captureAnchor(): { scrollY: number } | null {
    return { scrollY: window.scrollY };
  }

  /** 预留空间后补偿滚动，把视口拉回原位置，避免页面自动移动 */
  private releaseScroll(anchor: { scrollY: number } | null): void {
    if (!anchor) return;
    const delta = window.scrollY - anchor.scrollY;
    if (Math.abs(delta) > 1) window.scrollBy(0, -delta);
  }

  private setState(state: EngineState): void {
    // 悬停单译期间钳制状态机（见 suppressPageState）：off 恒放行，
    // 保证 restore 的收尾 setState("off") 永远不被钳制吞掉
    if (this.suppressPageState && state !== "off") return;
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

/** 收集页面上下文（标题/描述/正文摘要）：整页翻译注入，给模型提供语境；正文按设置上限截断。
 *  性能要点（大页面卡顿修复）：
 *  - 不深克隆整个 body、不读 innerText（两者在长文页会长时间阻塞主线程并强制整页排版）；
 *  - 改用 TreeWalker 原地遍历文本节点，textContent 取词（不触发排版），跳过脚本/样式/我们的 UI；
 *  - 累加到 maxChars 即提前停止，不先拼出整页长字符串再截断；
 *  - 用 skipSubtreeCache 记忆"该子树是否应跳过"，避免每个文本节点都向上爬全部祖先。 */
function getPageContext(maxChars: number): TranslationContext {
  const title = document.title.trim().slice(0, 200);
  const description =
    document
      .querySelector<HTMLMetaElement>('meta[name="description"], meta[property="og:description"]')
      ?.content.trim()
      .slice(0, 500) ?? "";
  const budget = Math.max(0, maxChars);
  let content = "";
  if (budget > 0 && document.body) {
    const SKIP_TAGS = new Set([
      "SCRIPT",
      "STYLE",
      "NOSCRIPT",
      "SVG",
      "IFRAME",
      "CANVAS",
      "TEMPLATE",
    ]);
    // 记忆已判定过的元素是否处于跳过子树，避免重复向上爬祖先
    const skipSubtreeCache = new Map<Element, boolean>();
    const isSkipSubtree = (el: Element): boolean => {
      let cached = skipSubtreeCache.get(el);
      if (cached !== undefined) return cached;
      let result = false;
      for (let p: Element | null = el; p; p = p.parentElement) {
        if (
          SKIP_TAGS.has(p.tagName) ||
          p.hasAttribute("data-it-ui") ||
          p.hasAttribute("data-it-unit")
        ) {
          result = true;
          break;
        }
      }
      skipSubtreeCache.set(el, result);
      return result;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (p && isSkipSubtree(p)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const parts: string[] = [];
    let len = 0;
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const t = (n.textContent ?? "").trim();
      if (!t) continue;
      parts.push(t);
      len += t.length + 1;
      if (len >= budget) break; // 达到上限即停，不遍历整页
    }
    content = parts.join(" ").replace(/\s+/g, " ").slice(0, budget);
  }
  return { title, description, content };
}

/** ===== HTML 属性翻译（placeholder / title / alt / aria-label） ===== */

const TRANSLATABLE_ATTRS = ["placeholder", "title", "alt", "aria-label"] as const;
type TranslatableAttr = (typeof TRANSLATABLE_ATTRS)[number];

/** 单条属性值翻译上限：更长的多半不是界面文案，跳过省 token */
const MAX_ATTR_TEXT = 500;
/** 属性候选元素上限：防超大页面扫描与请求量失控 */
const MAX_ATTR_CANDIDATES = 300;

/** 属性翻译元素级过滤：跳过我们的 UI、脚本/样式区、SVG、可编辑区与 aria-hidden / translate=no 子树。
 *  INPUT/TEXTAREA 虽在正文提取的排除标签内（它们的文本不可译），但其 placeholder 属性可译。 */
function isTranslatableAttrElement(el: HTMLElement, attr: TranslatableAttr): boolean {
  if (attr !== "placeholder" && EXCLUDED_TAGS.has(el.tagName)) return false;
  if (el.isContentEditable) return false;
  if (el.closest("[data-it-ui], [data-it-unit], svg") !== null) return false;
  if (el.closest('[aria-hidden="true"], [translate="no"]') !== null) return false;
  return true;
}

/** 属性值是否值得翻译：够长、含字母、且不是目标语言（与正文提取同一套启发式） */
function isTranslatableAttrText(text: string, targetLang: string): boolean {
  if (text.length < 2) return false;
  if (!LETTER_RE.test(text)) return false;
  return !isTargetLanguage(text, targetLang);
}

/** 首次修改前把该属性原文存进 data-it-attr-orig（JSON map），还原时据此恢复 */
function saveOriginalAttr(el: HTMLElement, attr: TranslatableAttr): void {
  let saved: Record<string, string> = {};
  const raw = el.getAttribute("data-it-attr-orig");
  if (raw) {
    try {
      saved = JSON.parse(raw) as Record<string, string>;
    } catch {
      saved = {};
    }
  }
  if (!(attr in saved)) saved[attr] = el.getAttribute(attr) ?? "";
  el.setAttribute("data-it-attr-orig", JSON.stringify(saved));
}
