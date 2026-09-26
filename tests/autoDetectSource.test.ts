// @vitest-environment jsdom
/**
 * translate.autoDetectSource 消费回归（幽灵设置项补齐实现）：
 * - 默认 true：整页翻译的上下文携带启发式检测出的源语言（免费通道 sl/from 参数 + LLM 提示词语境）；
 * - 显式 false（导入入口设置）：跳过源语言检测，上下文 sourceLang 置空——与"检测不出结果"
 *   的既有空值路径完全一致（LLM 不注入源语言行、免费通道不带 sl/from）。
 * 设置页未暴露该字段，默认行为不变；只有导入显式 false 才改变行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, uninstallChromeMock } from "./helpers/chromeMock";
import { PageEngine } from "../src/content/engine";
import { Renderer } from "../src/content/renderer";
import { DEFAULT_SETTINGS } from "../src/shared/storage";
import type { Settings } from "../src/shared/types";

interface RecordedTranslate {
  context?: { sourceLang?: string };
}

let sendMessage: ReturnType<typeof vi.fn>;
const translateCalls: RecordedTranslate[] = [];

function makeSettings(autoDetectSource: boolean): Settings {
  const base = structuredClone(DEFAULT_SETTINGS);
  return {
    ...base,
    translate: {
      ...base.translate,
      minTextLength: 2,
      viewportLazy: false,
      autoDetectSource,
    },
  };
}

beforeEach(() => {
  translateCalls.length = 0;
  sendMessage = vi.fn(async (msg: { type: string; texts?: string[]; id?: string }) => {
    if (msg?.type === "translate") {
      const m = msg as unknown as {
        id: string;
        texts: string[];
        context?: { sourceLang?: string };
      };
      translateCalls.push({ context: m.context });
      return { id: m.id, ok: true, results: (m.texts ?? []).map((t) => `【译】${t}`) };
    }
    if (msg?.type === "check-cache") return { cachedCount: 0 };
    return undefined;
  });
  installChromeMock({ extra: { runtime: { sendMessage } } });
});

afterEach(() => {
  uninstallChromeMock();
  vi.restoreAllMocks();
});

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 英文正文（避免被 isTargetLanguage 当作目标语言跳过）+ <html lang="zh">：
 *  默认路径下 html-lang 快速路径检测出 zh，上下文携带 sourceLang */
function setChinesePage(): void {
  document.documentElement.setAttribute("lang", "zh");
  document.body.innerHTML = '<p id="t">This is a plain English paragraph to translate.</p>';
}

describe("translate.autoDetectSource 消费", () => {
  it("默认 true：整页翻译上下文携带检测出的源语言（html lang=zh）", async () => {
    setChinesePage();
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings(true));
    await engine.translateAll();
    await waitFor(() => translateCalls.length > 0);
    expect(translateCalls[0].context?.sourceLang).toBe("zh");
  });

  it("显式 false：跳过源语言检测，上下文 sourceLang 为空", async () => {
    setChinesePage();
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings(false));
    await engine.translateAll();
    await waitFor(() => translateCalls.length > 0);
    expect(translateCalls[0].context?.sourceLang).toBe("");
  });
});
