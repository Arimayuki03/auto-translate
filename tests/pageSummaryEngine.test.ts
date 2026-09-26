// @vitest-environment jsdom
/**
 * LLM 页面摘要 × content 引擎集成回归（jsdom）：
 * - 长文页整页翻译：异步补摘要——首批请求无摘要，摘要返回后的批次自动携带；
 * - 短页（未达字数阈值）与开关关闭时不发摘要请求；
 * - 摘要请求携带截断正文与会话 id（还原/换页可中止）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, uninstallChromeMock } from "./helpers/chromeMock";
import { PageEngine } from "../src/content/engine";
import { Renderer } from "../src/content/renderer";
import { DEFAULT_SETTINGS } from "../src/shared/storage";
import type { Settings } from "../src/shared/types";

/** 轮询等待条件成立（引擎全异步链路，setTimeout 轮询最稳） */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface RecordedTranslate {
  context?: { summary?: string; content?: string };
}
interface RecordedPageSummary {
  title: string;
  content: string;
  sessionId?: number;
}

function makeEngineSettings(summaryEnabled: boolean, summaryMinChars: number): Settings {
  const base = structuredClone(DEFAULT_SETTINGS);
  return {
    ...base,
    translate: {
      ...base.translate,
      minTextLength: 2,
      viewportLazy: false,
      summaryEnabled,
      summaryMinChars,
    },
  };
}

/**
 * mock chrome：translate 响应等 batchGate（控制批次推进节奏）；
 * page-summary 响应等 summaryGate（控制摘要落定时机，保证首批请求先于摘要发出）。
 */
function mockContentChrome(batchGate: Promise<void>, summaryGate: Promise<void>): {
  translateCalls: RecordedTranslate[];
  pageSummaryCalls: RecordedPageSummary[];
} {
  const translateCalls: RecordedTranslate[] = [];
  const pageSummaryCalls: RecordedPageSummary[] = [];
  const sendMessage = vi.fn(async (raw: { type?: string }) => {
    if (raw?.type === "translate") {
      const m = raw as unknown as { id: string; texts: string[]; context?: { summary?: string } };
      translateCalls.push({ context: m.context });
      await batchGate;
      return { id: m.id, ok: true, results: (m.texts ?? []).map((t) => `【译】${t}`) };
    }
    if (raw?.type === "check-cache") return { cachedCount: 0 };
    if (raw?.type === "page-summary") {
      const m = raw as unknown as {
        id: string;
        title: string;
        content: string;
        sessionId?: number;
      };
      pageSummaryCalls.push({ title: m.title, content: m.content, sessionId: m.sessionId });
      await summaryGate;
      return { id: m.id, ok: true, summary: "全文摘要" };
    }
    return undefined;
  });
  installChromeMock({ extra: { runtime: { sendMessage } } });
  return { translateCalls, pageSummaryCalls };
}

function makeEngine(settings: Settings): PageEngine {
  const renderer = new Renderer("bilingual");
  renderer.setMode("bilingual");
  return new PageEngine(renderer, settings);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  uninstallChromeMock();
  vi.unstubAllGlobals();
});

describe("引擎：LLM 页面摘要触发", () => {
  it("长文页：首批上下文无摘要，摘要返回后的批次携带摘要", async () => {
    // 150 段 → 5 批（30/批）：FETCH_WINDOW=4，前 4 批在摘要前发出，第 5 批在摘要落定后发出
    document.body.innerHTML = Array.from(
      { length: 150 },
      (_, i) => `<p>Paragraph number ${i} with enough words to translate.</p>`
    ).join("");

    let openSummaryGate!: () => void;
    const summaryGate = new Promise<void>((r) => (openSummaryGate = r));
    let openBatchGate!: () => void;
    const batchGate = new Promise<void>((r) => (openBatchGate = r));
    const { translateCalls, pageSummaryCalls } = mockContentChrome(batchGate, summaryGate);

    const engine = makeEngine(makeEngineSettings(true, 10)); // 阈值极低：必为长文页
    const done = engine.translateAll();

    // 首批请求已发出（摘要尚未生成）：上下文无摘要字段
    await until(() => translateCalls.length > 0);
    expect(translateCalls[0].context).toBeTruthy();
    expect(translateCalls[0].context?.summary).toBeUndefined();
    expect(translateCalls[0].context?.content).toContain("Paragraph number 0");

    // 摘要请求已发出：携带截断正文与会话 id（gen 0）
    expect(pageSummaryCalls.length).toBeGreaterThan(0);
    expect(pageSummaryCalls[0].content).toContain("Paragraph number 0");
    expect(pageSummaryCalls[0].sessionId).toBe(0);

    // 放行摘要 → 引擎上下文并入摘要 → 放行批次响应 → 第 5 批在摘要落定后才发出
    openSummaryGate();
    await until(() => (engine as unknown as { pageContext?: { summary?: string } }).pageContext?.summary === "全文摘要");
    openBatchGate();
    await done;
    await until(() => translateCalls.length >= 5); // 150 段 → 30/批 × 5 批

    const withSummary = translateCalls.filter((c) => c.context?.summary !== undefined);
    expect(withSummary.length).toBeGreaterThan(0);
    expect(withSummary.every((c) => c.context?.summary === "全文摘要")).toBe(true);
    // 首批（或摘要前的批次）不带摘要字段
    const firstWith = translateCalls.findIndex((c) => c.context?.summary !== undefined);
    expect(firstWith).toBeGreaterThan(0);
  });

  it("短页（未达字数阈值）：不发摘要请求，翻译不受影响", async () => {
    document.body.innerHTML = "<p>Short page content here.</p>";
    const { translateCalls, pageSummaryCalls } = mockContentChrome(
      Promise.resolve(),
      Promise.resolve()
    );
    const engine = makeEngine(makeEngineSettings(true, 100000));
    await engine.translateAll();
    await until(() => translateCalls.length > 0);
    expect(pageSummaryCalls).toHaveLength(0);
    expect(translateCalls[0].context?.content).toContain("Short page content");
  });

  it("开关关闭：即使阈值为 0 也不发摘要请求", async () => {
    document.body.innerHTML = "<p>Some content here to translate.</p>";
    const { translateCalls, pageSummaryCalls } = mockContentChrome(
      Promise.resolve(),
      Promise.resolve()
    );
    const engine = makeEngine(makeEngineSettings(false, 0));
    await engine.translateAll();
    await until(() => translateCalls.length > 0);
    expect(pageSummaryCalls).toHaveLength(0);
  });
});
