// @vitest-environment jsdom
/**
 * 孤儿译文块回归（结论2 P0-1）：
 * 站点（React 重渲染 / 虚拟列表回收）把已译容器摘除、.it-wrap 层留在文档里时，
 * 用户点「还原」不得把译文块留成永久孤儿——旧实现 restore() 对失连容器直接
 * continue，随后 byContainer.clear() 丢索引，残块再无任何路径能清掉。
 * 同样检查 setMode 的索引驱逐路径（驱逐前先清理）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageEngine } from "../src/content/engine";
import { Renderer } from "../src/content/renderer";
import type { Settings } from "../src/shared/types";

function makeSettings(): Settings {
  return {
    enabled: true,
    api: {
      format: "openai",
      baseUrl: "http://t",
      apiKey: "k",
      model: "m",
      temperature: 0.3,
      timeoutMs: 60000,
      maxConcurrency: 3,
    },
    translate: {
      targetLang: "zh-CN",
      displayMode: "bilingual",
      autoTranslate: true,
      autoDetectSource: true,
      minTextLength: 2,
      blockMaxChars: 1200,
      translateOnSelect: true,
      translateInput: true,
      translateHover: false,
      viewportLazy: false,
      terminology: [],
    },
    sites: { whitelist: [], blacklist: [] },
    tts: { enabled: true, voice: "", rate: 0 },
    security: { encryptApiKey: false, sensitivePages: false },
    cache: { enabled: true, maxEntries: 500 },
  };
}

function mockChrome(): ReturnType<typeof vi.fn> {
  const sendMessage = vi.fn(async (msg: { type: string; texts?: string[]; id?: string }) => {
    if (msg?.type === "translate") {
      return { id: msg.id, ok: true, results: (msg.texts ?? []).map((t) => `【译】${t}`) };
    }
    if (msg?.type === "check-cache") return { cachedCount: 0 };
    return undefined;
  });
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { sendMessage },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
  } as unknown as typeof chrome;
  return sendMessage;
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  mockChrome();
});

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

describe("容器被站点摘除后的还原", () => {
  it("站点仅摘走原文容器（.it-wrap 留在文档）：restore 后文档里不得残留 .it-wrap/.it-translated", async () => {
    document.body.innerHTML = `<div id="feed"><p>Hello world paragraph.</p><p>Another paragraph here.</p></div>`;
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    await engine.translateAll();
    await waitFor(() => document.querySelectorAll(".it-wrap").length > 0);
    expect(document.querySelectorAll(".it-translated").length).toBeGreaterThan(0);

    // 模拟虚拟列表回收：站点持有的是原容器引用，remove() 只摘走 .it-orig，包裹层原地留守
    const orphans = [...document.querySelectorAll<HTMLElement>(".it-wrap > .it-orig")];
    expect(orphans.length).toBeGreaterThan(0);
    for (const c of orphans) c.remove();

    engine.restore();
    expect(document.querySelectorAll(".it-wrap").length).toBe(0);
    expect(document.querySelectorAll(".it-translated").length).toBe(0);
    // 被站点摘走的原文不得被「还原」复活回文档
    for (const c of orphans) expect(c.isConnected).toBe(false);
  });

  it("setMode 的失连驱逐路径：先清理再丢索引，restore 不留残块", async () => {
    document.body.innerHTML = `<div id="feed"><p>Hello world paragraph.</p><p>Yet another paragraph.</p></div>`;
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    await engine.translateAll();
    await waitFor(() => document.querySelectorAll(".it-wrap").length > 0);

    const orphans = [...document.querySelectorAll<HTMLElement>(".it-wrap > .it-orig")];
    for (const c of orphans) c.remove();

    // 切一次显示模式：旧实现会在这里把失连条目从 byContainer 直接删掉（不清理），
    // 之后的 restore() 就再也看不到这些条目
    engine.renderer.setMode("translated");
    engine.renderer.setMode("bilingual");
    expect(document.querySelectorAll(".it-wrap").length).toBe(0); // 驱逐即已清干净

    engine.restore();
    expect(document.querySelectorAll(".it-wrap").length).toBe(0);
    expect(document.querySelectorAll(".it-translated").length).toBe(0);
  });

  it("回收节点重新挂回时不带任何扩展标记", async () => {
    document.body.innerHTML = `<div id="feed"><p>Hello world paragraph.</p></div>`;
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    await engine.translateAll();
    await waitFor(() => document.querySelectorAll(".it-wrap").length > 0);

    // 整棵子树暂时脱离文档（折叠面板 / 虚拟列表把节点摘进回收池）
    const container = document.querySelector<HTMLElement>(".it-wrap > .it-orig");
    expect(container).not.toBeNull();
    const feed = document.getElementById("feed")!;
    container!.remove(); // 从 wrap 里摘走（wrap 仍留在文档 → 场景 1）；再整块脱离
    const detachedWrap = document.querySelector<HTMLElement>(".it-wrap")!;
    detachedWrap.remove();

    engine.restore();

    // 站点把该节点挂回：此时它应是干净的原文节点，可被正常再翻译
    feed.appendChild(container!);
    expect(container!.hasAttribute("data-it-src")).toBe(false);
    expect(container!.classList.contains("it-orig")).toBe(false);
    expect(container!.querySelectorAll(".it-translated").length).toBe(0);
    expect(container!.textContent).toContain("Hello world paragraph.");
  });
});
