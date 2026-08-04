/**
 * SPA 动态内容：MutationObserver 防抖 → 提取新增单元 → 交给引擎视口优先调度。
 * 观察根固定在 <html>（documentElement）而不是 <body> —— GitHub/Turbo 等 SPA 换页会
 * 整体替换 <body> 元素，若观察 body，观察器会随旧 body 一起失效，导致新页面不再自动翻译。
 */
import type { PageEngine } from "./engine";
import { extractUnits } from "./extractor";

const DEBOUNCE_MS = 300;

export class PageObserver {
  private mo: MutationObserver | null = null;
  private timer: number | undefined;
  private lastBody: HTMLElement;
  /** <body> 被整体替换（SPA 整页换页）时回调：用于重置引擎状态、重建工具条并按需重译 */
  onRootReplaced?: () => void;
  /** 当前页面是否敏感页（登录/密码/2FA 等），敏感时跳过自动翻译 */
  isSensitive?: () => boolean;
  /** 当前子页是否被用户「还原」过（禁用自动翻译），只影响该子页 */
  isPageDisabled?: () => boolean;

  constructor(private engine: PageEngine) {
    this.lastBody = document.body;
    this.mo = new MutationObserver(() => this.schedule());
    this.mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  /** bfcache 恢复后重建观察器（pageshow persisted 时观察器可能已失活） */
  rebind(): void {
    this.mo?.disconnect();
    this.mo = new MutationObserver(() => this.schedule());
    this.mo.observe(document.documentElement, { childList: true, subtree: true });
    this.lastBody = document.body;
  }

  /** 停止监听并清理挂起的防抖（测试/销毁用） */
  disconnect(): void {
    this.mo?.disconnect();
    this.mo = null;
    clearTimeout(this.timer);
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
    const units = extractUnits(document.body, this.engine.extractOptions).filter(
      (u) =>
        !u.container.hasAttribute("data-it-src") &&
        !u.container.hasAttribute("data-it-processing")
    );
    if (units.length > 0) this.engine.scheduleUnits(units); // 引擎内部：视口内先译，视口外滚动再译
    void this.engine.translatePlaceholders(); // 新出现的搜索框 placeholder 也翻译
  }
}
