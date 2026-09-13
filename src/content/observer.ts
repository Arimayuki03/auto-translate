/**
 * SPA 动态内容：MutationObserver 防抖 → 提取新增单元 → 交给引擎视口优先调度。
 * 观察根固定在 <html>（documentElement）而不是 <body> —— GitHub/Turbo 等 SPA 换页会
 * 整体替换 <body> 元素，若观察 body，观察器会随旧 body 一起失效，导致新页面不再自动翻译。
 */
import type { PageEngine } from "./engine";
import { extractUnits, extractUnitsChunked } from "./extractor";
import type { TranslationUnit } from "./extractor";

const DEBOUNCE_MS = 300;
/** off / hidden / 敏感页期间 roots 不被消费（run 早退）：设上限丢弃最老的根，
 *  防止长期挂着动态页面时无界积累已脱离 DOM 的节点引用（内存泄漏）。 */
const MAX_PENDING_ROOTS = 300;

export class PageObserver {
  private mo: MutationObserver | null = null;
  private timer: number | undefined;
  private lastBody: HTMLElement;
  /** 最近一批突变里被判定为"我们注入"的节点缓存，避免同一节点被多条 record 重复爬祖先 */
  private ownNodeCache = new WeakSet<Node>();
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
  private onClick = (): void => this.schedule();

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
   *  在大页面上叠加成严重卡顿。只要混入任何一处"非我们"的变化就照常调度。 */
  private onMutations(records: MutationRecord[]): void {
    for (const r of records) {
      if (!this.isOwnRecord(r)) {
        // 外部变化：收集新增节点供 run 增量扫描
        for (const n of r.addedNodes) {
          if (!this.addedRootsSeen.has(n)) {
            this.addedRootsSeen.add(n);
            if (this.addedRoots.length >= MAX_PENDING_ROOTS) this.addedRoots.shift();
            this.addedRoots.push(n);
          }
        }
        this.schedule();
        return;
      }
    }
    // 全是自身渲染引起的变化 → 忽略
  }

  /** 单条突变记录是否完全由我们的渲染引起 */
  private isOwnRecord(record: MutationRecord): boolean {
    if (record.type !== "childList") return false; // 非 childList 无法判定，保守视为外部变化
    for (const n of record.addedNodes) if (!this.isOwnNode(n)) return false;
    for (const n of record.removedNodes) if (!this.isOwnNode(n)) return false;
    return true;
  }

  /** 节点自身或任一祖先带我们的标记（data-it-* / it-* 类）→ 是我们注入/翻译的产物。
   *  用 WeakSet 缓存本批判定结果，避免同一节点被多条 record 重复爬祖先。 */
  private isOwnNode(node: Node): boolean {
    if (this.ownNodeCache.has(node)) return true;
    // 用 closest 一次匹配所有标记，比手写遍历 attributes + classList 更快
    let el: Element | null =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.nodeType === Node.TEXT_NODE
          ? node.parentElement
          : null;
    if (el && el.closest("[data-it-unit],[data-it-ui],.it-translated,.it-wrap,.it-orig")) {
      this.ownNodeCache.add(node);
      return true;
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
      this.onRootReplaced?.();
      return;
    }
    if (document.hidden) return; // 后台标签页不翻译
    if (this.isSensitive?.()) return; // 敏感页不自动翻译（换页后动态判断）
    if (this.isPageDisabled?.()) return; // 该子页被禁用自动翻译
    if (this.engine.state === "off") return; // 未启用/已还原时不翻译
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
    if (units.length > 0) this.engine.scheduleUnits(units); // 引擎内部：视口内先译，视口外滚动再译
    void this.engine.translatePlaceholders(); // 新出现的搜索框 placeholder 也翻译
  }
}
