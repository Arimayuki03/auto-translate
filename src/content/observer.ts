/** SPA 动态内容：MutationObserver 防抖 → 提取新增单元 → 交给引擎视口优先调度 */
import type { PageEngine } from "./engine";
import { extractUnits } from "./extractor";

const DEBOUNCE_MS = 300;

export class PageObserver {
  private mo: MutationObserver | null = null;
  private timer: number | undefined;

  constructor(private engine: PageEngine) {
    this.mo = new MutationObserver(() => this.schedule());
    this.mo.observe(document.body, { childList: true, subtree: true });
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, DEBOUNCE_MS);
  }

  private async run(): Promise<void> {
    if (document.hidden) return; // 后台标签页不翻译
    if (this.engine.state === "off") return; // 未启用/已还原时不翻译
    const units = extractUnits(document.body, this.engine.extractOptions).filter(
      (u) =>
        !u.container.hasAttribute("data-it-src") &&
        !u.container.hasAttribute("data-it-processing")
    );
    if (units.length === 0) return;
    this.engine.scheduleUnits(units); // 引擎内部：视口内先译，视口外滚动再译
  }
}
