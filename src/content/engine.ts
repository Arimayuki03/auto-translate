/** 页面翻译引擎：视口优先 + 滚动懒翻译 / 去重分批 / 顺序渲染 / 段落翻译 / 重试 / 还原 */
import type {
  CancelTranslationMessage,
  CheckCacheMessage,
  PageSummaryRequestMessage,
  PageSummaryResponseMessage,
  TranslationContext,
} from "../shared/messages";
import type { ResolvedSiteRule } from "../shared/siteRules";
import { detectPageSourceLang } from "../shared/langDetect";
import type { Settings } from "../shared/types";
import {
  extractUnits,
  extractUnitsChunked,
  isTargetLanguage,
  EXCLUDED_TAGS,
  LETTER_RE,
} from "./extractor";
import type { ExtractOptions, TranslationUnit } from "./extractor";
import { precomputeStyles, Renderer } from "./renderer";
import { createWorkPacer, pauseIfBudgetSpent } from "./scheduler";
import { translateTexts, TranslateError } from "./translate";
import { inViewport, partition, viewportOrderKey } from "./ui";

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
  /** LLM 页面摘要：长文页（正文超 summaryMinChars）整页翻译期间异步补一条文章摘要进上下文 */
  private summaryEnabled: boolean;
  private summaryMinChars: number;
  /** HTML 属性翻译开关（placeholder / title / alt / aria-label） */
  private attributesEnabled: boolean;
  /** 强制源语言：空串 = 自动检测（html lang / 启发式） */
  private forceSourceLang: string;
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
  private generationValue = 0;
  /** 批次令牌源：每次 translateUnits 进入时自增。同时写到单元对象的 batchToken 与
   *  容器 data-it-processing 属性值上——渲染时比对「单元令牌 === 容器当前令牌」，
   *  restoreElement/重排把容器标记摘掉或换成新批次的令牌后，旧批次结果即被作废，
   *  保证「还原该段」后不会又被在途的旧翻译回填出译文 */
  private batchSeq = 0;
  /** 用户是否手动还原过本页（点「还原」）：自动翻译不应再把本页译回来 */
  private userRestored = false;
  /** 最近一次翻译失败的错误（带类型与脱敏诊断）：工具条显示具体原因、可复制诊断 */
  lastError?: TranslateError;

  constructor(renderer: Renderer, settings: Settings, siteRule?: ResolvedSiteRule) {
    this.renderer = renderer;
    this.opts = {
      minTextLength: settings.translate.minTextLength,
      blockMaxChars: settings.translate.blockMaxChars,
      targetLang: settings.translate.targetLang,
      // 站点规则库（shared/siteRules 解析产物）：排除区选择器 / 不翻译标签 / 强制块级标签
      excludeTags: siteRule?.excludeTags,
      forceBlockTags: siteRule?.forceBlockTags,
      excludeSelector: siteRule?.excludeSelector ?? null,
    };
    this.targetLang = settings.translate.targetLang;
    this.glossary = settings.translate.terminology;
    this.viewportLazy = settings.translate.viewportLazy;
    this.contextEnabled = settings.translate.contextEnabled ?? true;
    this.contextMaxChars = Math.max(200, settings.translate.contextMaxChars ?? 3000);
    this.summaryEnabled = settings.translate.summaryEnabled ?? false;
    this.summaryMinChars = Math.max(0, settings.translate.summaryMinChars ?? 6000);
    this.attributesEnabled = settings.translate.translateAttributes ?? true;
    this.forceSourceLang = settings.translate.forceSourceLang ?? "";
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

  /** SPA 换页后按新 URL 重解析站点规则（index.ts 在导航回调里调用）：
   *  排除区/排除标签/强制块级即时生效，后续提取与属性翻译都用新规则。 */
  applySiteRule(siteRule: ResolvedSiteRule): void {
    this.opts = {
      ...this.opts,
      excludeTags: siteRule.excludeTags,
      forceBlockTags: siteRule.forceBlockTags,
      excludeSelector: siteRule.excludeSelector ?? null,
    };
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

  /** 当前会话代次：观察器扫描跨 await 让出，用「扫描前后代次一致」判断扫描期间是否被还原 */
  get generation(): number {
    return this.generationValue;
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
      const gen = this.generationValue;
      const collected = this.contextEnabled
        ? getPageContext(this.contextMaxChars, this.summaryEnabled ? this.summaryMinChars : 0)
        : undefined;
      this.pageContext = collected?.context;
      // 源语言检测（html lang / 启发式 / 用户强制）：随上下文带给 background（提示词 + 免费通道参数）
      if (this.pageContext) {
        this.pageContext = {
          ...this.pageContext,
          sourceLang: detectPageSourceLang(this.forceSourceLang, collected?.context.content ?? ""),
        };
      }
      // LLM 页面摘要（未来方向 P2）：长文页异步补一条文章摘要进上下文。
      // 不 await——首批请求先带「标题/描述/正文截断」发出，摘要返回后的批次自动携带；
      // 摘要按页缓存在 background，重复翻译/回访时首个请求就能拿到。
      if (
        collected?.context &&
        this.summaryEnabled &&
        collected.context.content &&
        collected.totalLen >= this.summaryMinChars
      ) {
        void this.enrichPageSummary(gen, this.pageContext!); // base 含 sourceLang 扩展（引用校验用）
      }
      // 全页扫描用时间片版提取：超大页面不再一次性阻塞主线程（借鉴 read-frog chunked walk）。
      // 让出期间若被还原（generation 变化）则中止本次。
      const extracted = await extractUnitsChunked(
        document.body,
        this.opts,
        () => gen === this.generationValue
      );
      if (gen !== this.generationValue) return;
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
      if (gen !== this.generationValue) return; // 等待期间被还原，放弃本次
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

  /**
   * 请求 background 生成/读取 LLM 页面摘要并并入页面上下文（best-effort 增强）：
   * 失败/被中止时保持「标题/描述/正文截断」原样，翻译不受影响。
   * 结果只并入本次翻译会话的上下文：还原/换页（代次变化）或 translateAll 已重建上下文时丢弃，
   * 避免把上一轮/旧页的摘要串进新一轮。
   */
  private async enrichPageSummary(gen: number, base: TranslationContext): Promise<void> {
    const req: PageSummaryRequestMessage = {
      type: "page-summary",
      id: `ps-${Date.now()}-${++summaryMsgSeq}`,
      title: base.title ?? "",
      content: base.content ?? "",
      sessionId: gen,
    };
    try {
      const res = (await chrome.runtime.sendMessage(req)) as PageSummaryResponseMessage | undefined;
      if (!res?.ok || !res.summary) return;
      if (gen !== this.generationValue) return;
      if (this.pageContext !== base) return;
      this.pageContext = { ...base, summary: res.summary };
    } catch {
      // 消息通道异常（如 SW 重启窗口）：摘要缺席不影响翻译
    }
  }

  /** 翻译页面属性文案（placeholder / title / alt / aria-label）：去重 + 术语表 + 防重复 */
  async translateAttributes(): Promise<void> {
    if (!this.attributesEnabled) return;
    const gen = this.generationValue;
    // 一次性收集全部可译属性候选，按文本去重后一次批译（与 placeholder 管线同思路）
    const candidates: Array<{ el: HTMLElement; attr: TranslatableAttr; text: string }> = [];
    for (const attr of TRANSLATABLE_ATTRS) {
      const sel =
        attr === "placeholder" ? "input[placeholder], textarea[placeholder]" : `[${attr}]`;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        if (candidates.length >= MAX_ATTR_CANDIDATES) break;
        if (el.hasAttribute("data-it-attr-done")) continue;
        if (!isTranslatableAttrElement(el, attr, this.opts)) continue;
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
    if (gen !== this.generationValue) return; // 期间被还原，放弃

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
    document
      .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-it-ph-done]")
      .forEach((el) => {
        const orig = el.getAttribute("data-it-ph-orig");
        if (orig !== null) el.placeholder = orig;
        el.removeAttribute("data-it-ph-orig");
        el.removeAttribute("data-it-ph-done");
      });
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
    this.userRestored = false; // 旧页的「还原过」标记不带到新页：新页照常自动翻译
    this.cancelSession(this.generationValue); // SPA 换页：中止旧页在途请求
    this.generationValue++; // 在途翻译结果作废（旧页容器已脱离文档）
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
    // 在途批次因代次作废提前返回时不会走 afterGroup，state 会永久卡在 translating
    // （工具条「翻译/还原」按钮禁用且无恢复路径）。兜底回到 done：保留「翻译态」语义
    // （SPA 重译判定 state !== "off" 依然成立），同时解除按钮禁用；新页敏感/后台时用户仍可手动还原。
    if (this.state === "translating") this.setState("done");
  }

  /** 总开关关闭触发的还原：系统行为，不是用户的「还原」意愿——restore() 会置
   *  userRestored（visibilitychange 补译路径会永久拒绝），若照搬，后台标签页里
   *  关开一轮后切回前台永远不再自动翻译。还原动作照常做，做完清掉意愿标记。 */
  restoreForSwitchOff(): void {
    this.restore();
    this.userRestored = false;
  }

  /** 一键还原 */
  restore(): void {
    this.userRestored = true; // 用户明确还原，自动翻译不再把本页译回来
    this.suppressPageState = false; // 解除悬停单译的状态钳制
    this.cancelSession(this.generationValue); // 中止当前会话在途请求，不浪费额度/算力
    this.generationValue++; // 在途翻译结果作废
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

  /**
   * 单元素还原（悬停「还原」角标）：只还原该元素承载的译文，不推整页状态机、
   * 不动代次（其他段落的在途翻译不受影响）。文本级去重同步移除对应原文——
   * 否则再悬停同段会被 isSkipped 压住，出不了「译」角标。
   * 同时把该元素从一切排队/在途管线里摘出来：否则用户刚点完还原，同一批次
   * 或后续懒翻译到达后又会把译文填回去（表现为「还原不掉、译文不断冒出来」）。
   */
  restoreElement(el: Element): void {
    if (!(el instanceof HTMLElement) || !el.isConnected) return;
    // 先解包还原再提取：包裹态下原文容器位于 .it-wrap（带 data-it-unit 排除标记）内部，
    // 提取器会把整棵子树当译文结构跳过，先还原才能拿到原文文本
    this.renderer.restoreElement(el);
    // 撤销排队：懒观察队列中的单元直接丢出队列；处理标记一并摘除，容器回到「未译」态
    for (const c of [...this.lazyUnits.keys()]) {
      if (c === el || el.contains(c)) {
        this.lazyUnits.delete(c);
        this.lazyIO?.unobserve(c);
      }
    }
    this.lazyPending = this.lazyPending.filter(
      (u) => !(u.container === el || el.contains(u.container))
    );
    // 索引里登记过的单元逐个撤销：摘处理标记（在途批次的渲染阶段会因令牌失配丢弃结果）、
    // 退出调度集合、清理索引与文本级去重（共享文本仅在无兄弟单元时清）
    const removed: TranslationUnit[] = [];
    for (const u of this.allUnits.values()) {
      if (u.container === el || el.contains(u.container)) removed.push(u);
    }
    for (const u of removed) {
      u.container.removeAttribute("data-it-processing");
      this.scheduledContainers.delete(u.container);
      this.allUnits.delete(u.id);
      const list = this.unitsByText.get(u.text);
      if (list) {
        const idx = list.indexOf(u);
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) this.unitsByText.delete(u.text);
      }
    }
    // 兜底摘除残留处理标记：占位阶段（reserve 让出窗口内）的容器尚未登记进 allUnits，
    // 上面按索引的撤销够不着它们；再悬停同段时这里保证容器回到「未译」态
    if (el.hasAttribute("data-it-processing")) el.removeAttribute("data-it-processing");
    el.querySelectorAll<HTMLElement>("[data-it-processing]").forEach((c) =>
      c.removeAttribute("data-it-processing")
    );
    // 文本级去重同步移除对应原文（本元素独有的文本；共享文本仅在无兄弟单元时清）
    const texts = new Set(extractUnits(el, this.opts).map((u) => u.text));
    let doneRevoked = 0;
    let revoked = 0;
    for (const text of texts) {
      if (this.doneTexts.delete(text)) {
        doneRevoked++;
        revoked++;
      } else if (this.pendingTexts.delete(text)) {
        revoked++;
      }
    }
    // 只有已完成文本占过 stats.done：在途段落撤销只该冲抵 total，
    // done 一并反扣会把其它段落的完成数少计（工具条「已译 N 段」缩水）
    this.stats.done = Math.max(0, this.stats.done - doneRevoked);
    this.stats.total = Math.max(0, this.stats.total - revoked);
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

  /** 处理一组单元：预留空间 → 标记在途 → 视口优先分批 → 并发请求 → 完成即渲染 */
  async translateUnits(units: TranslationUnit[]): Promise<void> {
    if (units.length === 0) return;
    // 视口优先排序：距视口近的单元先进批、先请求先渲染（稳定排序，同距离保持 DOM 顺序，
    // jsdom 等 rect 恒 0 的环境退化为原 DOM 顺序）。整页直译（缓存命中/关懒翻译）时，
    // 用户停在页面中部也能先看到当前屏幕的译文。
    const ordered =
      units.length > 1
        ? [...units].sort((a, b) => viewportOrderKey(a.container) - viewportOrderKey(b.container))
        : units;
    for (const u of ordered) this.scheduledContainers.delete(u.container);
    const gen = this.generationValue; // 捕获本批代次
    const anchor = this.captureAnchor();
    // 批次令牌：同时落在单元对象与容器 data-it-processing 的属性值上。
    // 单元素还原（restoreElement）/ 重试会摘掉或换掉容器标记，渲染时据此丢弃被撤销的单元，
    // 保证「还原该段」后不会又被仍在途的旧批次把译文填回去。
    const token = `it-batch-${++this.batchSeq}`;
    for (const u of ordered) {
      u.batchToken = token;
      u.container.setAttribute("data-it-processing", token);
    }
    // 预留译文空间（不可见占位），填充在原位，避免页面跳动。
    // 性能要点（大页面卡顿修复）：
    //  1) 先一次性预读所有容器的样式（getComputedStyle/clientWidth），此时尚无
    //     结构性 DOM 写入，只触发一次重排；
    //  2) 占位插入阶段直接用预读值，循环里不再读几何/样式属性；
    //  3) 占位插入按时间片配速（每 12ms 让出主线程），大页面几十次 DOM 插入不再堆在
    //     一个同步任务里冻结页面；每次让出后校验代次，还原即中止。
    const pacer = createWorkPacer();
    const styleMap = precomputeStyles(ordered);
    for (let i = 0; i < ordered.length; i++) {
      const u = ordered[i];
      // 撤销守卫：容器令牌已被 restoreElement 摘掉/换新 → 不再复活占位。
      // 否则重新套壳的 .it-wrap + 隐形占位会因渲染守卫丢弃结果而永久残留
      if (u.container.getAttribute("data-it-processing") === u.batchToken) {
        this.renderer.reserve(u, styleMap.get(u.container));
      }
      await pauseIfBudgetSpent(pacer);
      if (gen !== this.generationValue) return; // 让出期间被还原 → 中止，不再继续占位/请求
    }
    this.releaseScroll(anchor);
    // 让出窗口内被还原的单元就此完全退场：不登记索引（否则 retry/观察器把它当在途）、
    // 不参与请求（省额度）；渲染守卫只是最后防线，不是去重出口
    const alive = ordered.filter(
      (u) => u.container.getAttribute("data-it-processing") === u.batchToken
    );
    if (alive.length === 0) {
      // 全部被还原：不推状态、不发请求，但调度计数照常冲减（与末尾口径一致）
      this.pendingCount = Math.max(0, this.pendingCount - units.length);
      return;
    }
    // 索引登记：allUnits（按 id）+ unitsByText（按文本，retry 用）
    for (const u of alive) {
      if (this.allUnits.size < MAX_UNITS) {
        this.allUnits.set(u.id, u);
        let list = this.unitsByText.get(u.text);
        if (!list) this.unitsByText.set(u.text, (list = []));
        list.push(u);
      }
    }
    this.setState("translating");

    const byText = new Map<string, TranslationUnit[]>();
    for (const u of alive) {
      const list = byText.get(u.text) ?? [];
      list.push(u);
      byText.set(u.text, list);
    }
    const batches = buildBatches([...byText.entries()]);

    // 视口优先调度：批次按「距视口距离」动态出队——每次出队前按当前视口重选最近的批，
    // 滚动后未发出的批次会跟随用户位置；先完成的批先渲染（不再按固定批次顺序等待，
    // 消除队头阻塞）。请求并发度仍由 FETCH_WINDOW 钳制，后台统一限流不变。
    let batchIdSeq = 0;
    const pending: PendingBatch[] = batches.map((batch) => ({
      batch,
      anchor: batch[0]![1][0]!.container,
    }));
    const inFlight = new Map<number, Promise<BatchResult>>();

    const startNext = (): void => {
      if (pending.length === 0) return;
      if (pending.length > 1) {
        let best = 0;
        let bestDist = viewportOrderKey(pending[0]!.anchor);
        for (let i = 1; i < pending.length; i++) {
          const d = viewportOrderKey(pending[i]!.anchor);
          if (d < bestDist) {
            bestDist = d;
            best = i;
          }
        }
        // 距离并列时不动（保持 DOM 顺序）；仅在有更近批时前移
        if (best > 0) pending.unshift(pending.splice(best, 1)[0]!);
      }
      const next = pending.shift()!;
      const id = ++batchIdSeq;
      inFlight.set(
        id,
        this.fetchBatch(next.batch).then((chunks) => ({ id, batch: next.batch, chunks }))
      );
    };

    for (let i = 0; i < FETCH_WINDOW && pending.length > 0; i++) startNext();
    while (inFlight.size > 0) {
      const { id, batch, chunks } = await Promise.race(inFlight.values());
      inFlight.delete(id);
      if (gen !== this.generationValue) return; // 期间被还原，丢弃后续结果
      if (chunks) {
        await this.renderBatch(batch, chunks, gen, pacer);
      } else {
        for (const u of batch.flatMap(([, us]) => us)) {
          // 撤销守卫与成功路径（renderBatch）同口径：已被还原的段落不显示失败占位、
          // 不计入失败数——否则「翻译失败 + 点过还原」会把错误条塞回用户刚还原的原文处
          if (u.container.getAttribute("data-it-processing") !== u.batchToken) continue;
          this.stats.error++;
          this.renderer.fail(u);
          u.container.removeAttribute("data-it-processing");
        }
      }
      if (gen !== this.generationValue) return;
      startNext();
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
    const session = this.generationValue; // 会话 id：还原/换页时 background 据此中止在途请求
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
    if (session !== this.generationValue) {
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
      // 该文本的全部单元在请求期间被单元素还原撤销（容器 processing 标记已摘或换了新令牌）
      // → 文本不再记入 doneTexts：否则再悬停「译」时被 isSkipped 压住，刷新页面前出不了角标
      const units = batch.find(([text]) => text === t)?.[1] ?? [];
      const allRevoked =
        units.length > 0 &&
        units.every((u) => u.container.getAttribute("data-it-processing") !== u.batchToken);
      if (!allRevoked && this.doneTexts.size < MAX_DONE_TEXTS) this.doneTexts.add(t);
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
        // 渲染守卫（按单元）：令牌失配 = 该单元已被还原/重试撤销，丢弃旧批次结果，
        // 不回填译文、不误计统计；标记由撤销方（restoreElement/retryState）负责清理
        if (u.container.getAttribute("data-it-processing") !== u.batchToken) continue;
        u.container.removeAttribute("data-it-processing");
        if (chunks && chunks.length > 0) {
          this.renderer.fill(u, chunks);
          filled++;
        } else {
          this.renderer.fail(u);
          failed++;
        }
        await pauseIfBudgetSpent(pacer);
        if (gen !== this.generationValue) {
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

/** 视口优先调度里的待发批次：anchor 取批内首个单元容器，出队时按它重算距视口距离 */
interface PendingBatch {
  batch: [string, TranslationUnit[]][];
  anchor: HTMLElement;
}

/** fetchBatch 的带批次完成结果（Promise.race 后按 id 回填渲染） */
interface BatchResult {
  id: number;
  batch: [string, TranslationUnit[]][];
  chunks: Map<string, string[]> | null;
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
 *  countUpTo：LLM 摘要启用时同步统计页面正文字数（计到该阈值即可判定长文页，无需全页精确值）；
 *  传 0 表示不需要统计（摘要关闭），遍历在 content 预算处提前停止，行为与历史版本一致。
 *  性能要点（大页面卡顿修复）：
 *  - 不深克隆整个 body、不读 innerText（两者在长文页会长时间阻塞主线程并强制整页排版）；
 *  - 改用 TreeWalker 原地遍历文本节点，textContent 取词（不触发排版），跳过脚本/样式/我们的 UI；
 *  - 达到 content 预算与字数阈值两者较早的停止点即停，不先拼出整页长字符串再截断；
 *  - 用 skipSubtreeCache 记忆"该子树是否应跳过"，避免每个文本节点都向上爬全部祖先。 */
function getPageContext(
  maxChars: number,
  countUpTo = 0
): { context: TranslationContext; totalLen: number } {
  const title = document.title.trim().slice(0, 200);
  const description =
    document
      .querySelector<HTMLMetaElement>('meta[name="description"], meta[property="og:description"]')
      ?.content.trim()
      .slice(0, 500) ?? "";
  const budget = Math.max(0, maxChars);
  const countBudget = Math.max(0, countUpTo);
  let content = "";
  let totalLen = 0;
  if ((budget > 0 || countBudget > 0) && document.body) {
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
      // content 预算与摘要字数统计两者都满足才停（budget 小 countUpTo 大时继续走到阈值）
      if (len >= budget && len >= countBudget) break;
    }
    content = parts.join(" ").replace(/\s+/g, " ").slice(0, budget);
    totalLen = len; // 计到停止点为止的近似全页字数（≥阈值即判长文页，无需精确）
  }
  return { context: { title, description, content }, totalLen };
}

/** 页面摘要请求 id 序列（同一页面内多次 translateAll 并发时保唯一） */
let summaryMsgSeq = 0;

/** ===== HTML 属性翻译（placeholder / title / alt / aria-label） ===== */

const TRANSLATABLE_ATTRS = ["placeholder", "title", "alt", "aria-label"] as const;
type TranslatableAttr = (typeof TRANSLATABLE_ATTRS)[number];

/** 单条属性值翻译上限：更长的多半不是界面文案，跳过省 token */
const MAX_ATTR_TEXT = 500;
/** 属性候选元素上限：防超大页面扫描与请求量失控 */
const MAX_ATTR_CANDIDATES = 300;

/** 属性翻译元素级过滤：跳过我们的 UI、脚本/样式区、SVG、可编辑区、aria-hidden /
 *  translate=no 子树，以及站点规则命中的排除区/排除标签。
 *  INPUT/TEXTAREA 虽在正文提取的排除标签内（它们的文本不可译），但其 placeholder 属性可译。 */
function isTranslatableAttrElement(
  el: HTMLElement,
  attr: TranslatableAttr,
  opts: ExtractOptions
): boolean {
  if (attr !== "placeholder" && EXCLUDED_TAGS.has(el.tagName)) return false;
  if (opts.excludeTags?.size && opts.excludeTags.has(el.tagName)) return false;
  if (opts.excludeSelector && el.closest(opts.excludeSelector) !== null) return false;
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
