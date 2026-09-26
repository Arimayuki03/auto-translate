/**
 * SPA 动态内容：MutationObserver 防抖 → 提取新增单元 → 交给引擎视口优先调度。
 * 观察根固定在 <html>（documentElement）而不是 <body> —— GitHub/Turbo 等 SPA 换页会
 * 整体替换 <body> 元素，若观察 body，观察器会随旧 body 一起失效，导致新页面不再自动翻译。
 */
import type { PageEngine } from "./engine";
import { extractUnits, extractUnitsChunked } from "./extractor";
import type { TranslationUnit } from "./extractor";

const DEBOUNCE_MS = 300;
/** 点击探测（全文档兜底扫描）的最小间隔：连续点击/选中文字不再每次都全量扫描 */
const CLICK_SCAN_MIN_INTERVAL_MS = 1000;
/** off / hidden / 敏感页期间 roots 不被消费（run 早退）：设上限丢弃最老的根，
 *  防止长期挂着动态页面时无界积累已脱离 DOM 的节点引用（内存泄漏）。 */
const MAX_PENDING_ROOTS = 300;

export class PageObserver {
  private mo: MutationObserver | null = null;
  private timer: number | undefined;
  private lastBody: HTMLElement;
  /** 判定为位于我们 UI 子树内的节点缓存：只有攀爬找到 data-it-ui 根的节点才进这里，
   *  这些节点必是 UI 树（完全由我们创建）的一员，缓存为真无误判外部节点的风险 */
  private ownUiCache = new WeakSet<Element>();
  /** 防抖窗口内累积的新增节点根（onMutations 收集，run 消费）。
   *  不能用 takeRecords()——onMutations 回调已消费了 records，takeRecords 只剩空。 */
  private addedRoots: Node[] = [];
  /** 去重集合用 WeakSet：off/hidden 期间 roots 长期不消费时，脱离 DOM 的节点仍可被 GC，
   *  不会像强引用 Set 一样无界积累。 */
  private addedRootsSeen = new WeakSet<Node>();
  /** <body> 被整体替换（SPA 整页换页）时回调：用于重置引擎状态、重建工具条并按需重译 */
  onRootReplaced?: () => void;
  /** 当前页面是否敏感页（登录/密码/2FA 等），敏感时跳过自动翻译 */
  isSensitive?: () => boolean;
  /** 当前子页是否被用户「还原」过（禁用自动翻译），只影响该子页 */
  isPageDisabled?: () => boolean;

  /** 点击探测：点击触发的组件（下拉菜单/弹出选项等）常通过 style/class/attribute
   *  切换显隐而不产生子节点突变，childList 观察器收不到通知——点击后主动补一次扫描，
   *  让"点击之后才出现的选项"也能被翻译 */
  private lastClickScan = 0;
  private onClick = (e: MouseEvent): void => {
    // 我们自己的 UI（工具条/气泡/角标/译文按钮）上的点击不触发扫描
    const t = e.target;
    if (t instanceof Element && t.closest("[data-it-ui]")) return;
    // 兜底扫描是大页面上的大开销：限流到约每秒一次，连点不再反复全量扫描；
    // 真实新增内容仍走 mutation 增量路径，不受此限流影响
    const now = Date.now();
    if (now - this.lastClickScan < CLICK_SCAN_MIN_INTERVAL_MS) return;
    this.lastClickScan = now;
    this.schedule();
  };

  constructor(private engine: PageEngine) {
    this.lastBody = document.body;
    this.mo = new MutationObserver((records) => this.onMutations(records));
    this.mo.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("click", this.onClick, true);
  }

  /** bfcache 恢复后重建观察器（pageshow persisted 时观察器可能已失活） */
  rebind(): void {
    this.mo?.disconnect();
    this.mo = new MutationObserver((records) => this.onMutations(records));
    this.mo.observe(document.documentElement, { childList: true, subtree: true });
    this.lastBody = document.body;
  }

  /** 变化过滤：若本批突变全部由我们自己的翻译/渲染产生（插入占位、包裹原文、
   *  回填译文、控件原位替换等），就不触发整页重扫——否则翻译过程会反复自激扫描，
   *  在大页面上叠加成严重卡顿。只要混入任何一处"非我们"的变化就照常调度。
   *  收集须遍历全部记录：同批多条外部记录各自携带 addedNodes，逐条收集完再统一
   *  调度一次（此前遇首条外部记录即 return，同批后续记录的新增根被整体丢弃）。 */
  private onMutations(records: MutationRecord[]): void {
    let sawExternal = false;
    for (const r of records) {
      if (!this.isOwnRecord(r)) {
        sawExternal = true;
        // 外部变化：收集新增节点供 run 增量扫描（继续遍历，不提前退出）
        for (const n of r.addedNodes) {
          if (!this.addedRootsSeen.has(n)) {
            this.addedRootsSeen.add(n);
            if (this.addedRoots.length >= MAX_PENDING_ROOTS) {
              // 溢出丢弃最老根时同步清 seen：否则该节点永占 seen 位，
              // 日后被移出再插回 DOM 时不再入队
              const dropped = this.addedRoots.shift();
              if (dropped) this.addedRootsSeen.delete(dropped);
            }
            this.addedRoots.push(n);
          }
        }
      }
    }
    if (sawExternal) this.schedule(); // 存在任何外部记录（含仅有 removedNodes 的）即调度
    // 全是自身渲染引起的变化 → 忽略
  }

  /** 单条突变记录是否完全由我们的渲染引起 */
  private isOwnRecord(record: MutationRecord): boolean {
    if (record.type !== "childList") return false; // 非 childList 无法判定，保守视为外部变化
    for (const n of record.addedNodes) if (!this.isOwnNode(n)) return false;
    for (const n of record.removedNodes) if (!this.isOwnNode(n)) return false;
    return true;
  }

  /** 节点本身是否我们的产物（或我们的渲染动作写入的节点）。只做直接判定与
   *  有界补判定，不再 closest 爬整条祖先链：站点把我们的产物包进它自己的新容器、
   *  或往产物内部插入新内容时，新容器/新内容节点自身不带标记，closest 会把它们
   *  连同整条记录误判为自身产物而漏扫。
   *  补判定清单（均来自 renderer/input 写入点核对，见 tests/observerScan.test.ts）：
   *  - 元素级借用标记 data-it-src / data-it-processing / data-it-inside：包裹搬运、
   *    解包、批次套壳期间被增删的站点容器（标记先于搬运写入，判定时必已在）；
   *  - 文本级快照标记 data-it-orig-text / data-it-ctl-*：我们原位替换/还原文字时
   *    插入的文本节点，其父元素必带快照标记；
   *  - it-chunk / it-err-text / it-input-btn：自身不带 data-it-* 的自产元素；
   *  - data-it-ui 子树内部节点（工具条/气泡/角标的按钮、面板、文字）：向上只认
   *    data-it-ui 根——UI 树完全由我们创建、不经过站点节点，攀爬结论为真时节点
   *    必是我们的，缓存无误判外部节点的风险。 */
  private isOwnNode(node: Node): boolean {
    const isTextNode = node.nodeType === Node.TEXT_NODE;
    const el =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : isTextNode
          ? node.parentElement
          : null;
    if (!el) return false;
    // 直接判定：我们创建并直接标记的节点（译文/占位/包裹层/UI 根/拆段与错误子元素）
    if (el.hasAttribute("data-it-unit") || el.hasAttribute("data-it-ui")) return true;
    if (
      el.classList.contains("it-translated") ||
      el.classList.contains("it-wrap") ||
      el.classList.contains("it-orig") ||
      el.classList.contains("it-chunk") ||
      el.classList.contains("it-err-text") ||
      el.classList.contains("it-input-btn")
    ) {
      return true;
    }
    if (isTextNode) {
      // 我们写入的文字：父元素带文字快照标记（原位替换/控件替换/还原时的增删）
      if (
        el.hasAttribute("data-it-orig-text") ||
        el.hasAttribute("data-it-ctl-orig") ||
        el.hasAttribute("data-it-ctl-trans")
      ) {
        return true;
      }
    } else if (
      el.hasAttribute("data-it-src") || // 翻译容器：包裹搬运/解包时被增删
      el.hasAttribute("data-it-processing") || // 批次套壳期间被移除的在途容器
      el.hasAttribute("data-it-inside") // 内插译文容器被搬运时
    ) {
      return true;
    }
    // UI 子树内部节点：向上只找 data-it-ui 根（UI 根挂在 body/documentElement 下，
    // 站点外部节点向上爬只会到 body/html，不会误入 UI 根）
    if (this.ownUiCache.has(el)) return true;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.hasAttribute("data-it-ui")) {
        this.ownUiCache.add(el);
        return true;
      }
    }
    return false;
  }

  /** 停止监听并清理挂起的防抖（测试/销毁用） */
  disconnect(): void {
    this.mo?.disconnect();
    this.mo = null;
    clearTimeout(this.timer);
    document.removeEventListener("click", this.onClick, true);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, DEBOUNCE_MS);
  }

  private async run(): Promise<void> {
    // body 引用变化 → SPA 整页换页（Turbo 等整体替换 <body>）。回调里统一重置并重译，
    // 增量提取交给下一次 mutation，避免这里与回调重复调度。
    if (this.lastBody !== document.body) {
      this.lastBody = document.body;
      // 丢弃防抖窗口内积累的旧页根：旧 body 被整体替换后这些节点已脱离 DOM，
      // 留着会在下一次 run 被照常提取并 scheduleUnits（懒翻译模式下进 lazyUnits
      // 永不触发造成泄漏；forceFull 模式下对死内容真实发翻译请求）。
      // seen 无消费对应关系，直接整体重建（WeakSet 无 clear()，字段可重赋值）。
      this.addedRoots.length = 0;
      this.addedRootsSeen = new WeakSet();
      this.onRootReplaced?.();
      return;
    }
    if (document.hidden) return; // 后台标签页不翻译
    if (this.isSensitive?.()) return; // 敏感页不自动翻译（换页后动态判断）
    if (this.isPageDisabled?.()) return; // 该子页被禁用自动翻译
    if (this.engine.state === "off") return; // 未启用/已还原时不翻译
    // 记录扫描开始时的代次：await 让出期间用户可能点了「还原」（generation++、state=off），
    // 扫描结果属于旧会话，调度前必须复核，否则刚还原的整页会又被扫出来的单元译回去
    const genAtScanStart = this.engine.generation;
    // 增量提取：只扫描防抖窗口内累积的新增子树，而不是整个 body。
    // 点击触发的组件（下拉菜单等）只切换 style 不新增节点 → addedRoots 为空时回退全量扫描。
    const roots = this.addedRoots;
    this.addedRoots = [];
    // seen 与 roots 同步消费：否则节点被移出再重新插入 DOM 时会被 seen 误判为已处理
    for (const r of roots) this.addedRootsSeen.delete(r);
    const units: TranslationUnit[] = [];
    if (roots.length > 0) {
      // 增量：只扫新增子树
      for (const root of roots) {
        if (!(root instanceof HTMLElement)) continue;
        if (root.closest("[data-it-unit],[data-it-ui]")) continue; // 我们自己的注入不扫
        const found = extractUnits(root, this.engine.extractOptions).filter(
          (u) =>
            u.container.isConnected && // 已脱离 DOM 的容器（旧页残留根）直接跳过
            !u.container.hasAttribute("data-it-src") &&
            !u.container.hasAttribute("data-it-processing") &&
            !this.engine.renderer.isFailed(u.container) &&
            !this.engine.isScheduled(u.container) &&
            !this.engine.isSkipped(u.text)
        );
        units.push(...found);
      }
    } else {
      // 无新增节点（如点击切换 style 显隐的下拉菜单）→ 全量扫描兜底。
      // 用时间片版：大页面每次点击都全量扫一遍时，不再一次性阻塞主线程。
      const found = (
        await extractUnitsChunked(document.body, this.engine.extractOptions, () => true)
      ).filter(
        (u) =>
          !u.container.hasAttribute("data-it-src") &&
          !u.container.hasAttribute("data-it-processing") &&
          !this.engine.renderer.isFailed(u.container) &&
          !this.engine.isScheduled(u.container) &&
          !this.engine.isSkipped(u.text)
      );
      units.push(...found);
    }
    // 让出/等待期间被还原（或换页重置）→ 本次扫描作废，不再调度。
    // state 经 getter 读出为 EngineState 联合类型，await 前已判过 off；这里快照到
    // string 再比较，避免 TS 把可变字段当成 await 间不变的收窄类型而报恒假
    const stateAfterScan: string = this.engine.state;
    if (genAtScanStart !== this.engine.generation || stateAfterScan === "off") return;
    if (units.length > 0) this.engine.scheduleUnits(units); // 引擎内部：视口内先译，视口外滚动再译
    void this.engine.translateAttributes(); // 新出现的搜索框 placeholder 也翻译
  }
}
