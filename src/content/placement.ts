/** fixed 浮层（悬停角标 / 划词气泡 / 输入框「译」按钮）的视口级定位。
 *  站点常在 body 或 html 上挂 transform / filter / will-change / contain / zoom
 *  （GPU 合成提升、模糊背景、滚动动画），此时 position:fixed 的包含块不再是视口，
 *  getBoundingClientRect 量出的视口坐标会被按包含块坐标系解释——浮层与目标元素错位
 *  约一个滚动距离（zoom 还要再乘缩放系数），滚动越深偏得越远。两层防御：
 *  1) 挂载到 <html> 下：属性只挂在 body 的多数站点由此直接恢复视口语义；
 *  2) 两点采样反解仿射映射 rendered = O + k × local（local 坐标 → 视口坐标），
 *     一次写入即精确——纯平移（含块偏移=±scrollY）与等比缩放（html zoom）通吃。
 *  调用方需在定位前让元素可见：未渲染的元素 rect 全 0，量不到映射。 */
export function placeFixedInViewport(el: HTMLElement, x: number, y: number): void {
  const root = document.documentElement;
  if (root && el.parentElement !== root) root.appendChild(el);
  el.style.left = "0px";
  el.style.top = "0px";
  const o = el.getBoundingClientRect();
  // 无布局环境（jsdom）或未渲染：rect 全 0，量不到映射，按视口语义直接写
  if (o.width <= 0 && o.height <= 0) {
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    return;
  }
  el.style.left = "100px";
  el.style.top = "100px";
  const p = el.getBoundingClientRect();
  // 平移失真采样得 k=1；缩放失真（zoom）解出实际比例。k 退化（异常布局）时按 1 处理
  const kx = Math.abs(p.left - o.left) > 1e-6 ? (p.left - o.left) / 100 : 1;
  const ky = Math.abs(p.top - o.top) > 1e-6 ? (p.top - o.top) / 100 : 1;
  el.style.left = `${Math.round((x - o.left) / kx)}px`;
  el.style.top = `${Math.round((y - o.top) / ky)}px`;
}
