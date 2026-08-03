/** SPA 动态内容 + 无感调度（5.6）：MutationObserver 防抖 → 提取新增单元 → 视口优先 + 空闲翻译 */
import type { PageEngine } from "./engine";
import { extractUnits } from "./extractor";

const DEBOUNCE_MS = 300;
const IDLE_TIMEOUT_MS = 3000;

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
    if (this.engine.state === "off") return; // 未启用/已还原时不翻译
    const units = extractUnits(document.body, this.engine.extractOptions).filter(
      (u) => !this.engine.isSkipped(u.text) && !u.container.hasAttribute("data-it-src")
    );
    if (units.length === 0) return;

    // 视口优先：视口内的先译，视口外的低优先级空闲翻译，滚动不被阻塞
    const [viewport, rest] = partition(units, (u) => inViewport(u.container));
    if (viewport.length > 0) await this.engine.translateUnits(viewport);
    if (rest.length > 0) {
      const run = () => void this.engine.translateUnits(rest);
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
      } else {
        setTimeout(run, 1000);
      }
    }
  }
}

function partition<T>(arr: T[], pred: (t: T) => boolean): [T[], T[]] {
  const a: T[] = [];
  const b: T[] = [];
  for (const x of arr) (pred(x) ? a : b).push(x);
  return [a, b];
}

function inViewport(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0;
}
