// @vitest-environment jsdom
/**
 * 观察器结构漏扫回归（P1 B3）：
 * 1. onMutations 遇首条外部记录不得提前 return——同批后续外部记录的 addedNodes 必须全部收集；
 * 2. isOwnNode 收紧为「节点本身是产物」直接判定（+ 有界 UI 子树补判定），
 *    外部节点不得因祖先带标记（closest 爬链）被误判为自身产物而漏扫。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, uninstallChromeMock } from "./helpers/chromeMock";
import { PageEngine } from "../src/content/engine";
import { PageObserver } from "../src/content/observer";
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
      viewportLazy: false,
      terminology: [],
    },
    sites: { whitelist: [], blacklist: [] },
    tts: { enabled: true, voice: "", rate: 0 },
    security: { encryptApiKey: false, sensitivePages: false },
    cache: { enabled: true, maxEntries: 500 },
  };
}

let sendMessage: ReturnType<typeof vi.fn>;

function mockChrome(): void {
  sendMessage = vi.fn(async (msg: { type: string; texts?: string[]; id?: string }) => {
    if (msg?.type === "translate") {
      return { id: msg.id, ok: true, results: (msg.texts ?? []).map((t) => `【译】${t}`) };
    }
    if (msg?.type === "check-cache") return { cachedCount: 0 };
    return undefined;
  });
  installChromeMock({ extra: { runtime: { sendMessage } } });
}

beforeEach(() => {
  document.body.innerHTML = "<p>Existing paragraph.</p>";
  mockChrome();
});

afterEach(() => {
  uninstallChromeMock();
  vi.restoreAllMocks();
});

function makeEngine(): PageEngine {
  const renderer = new Renderer("bilingual");
  renderer.setMode("bilingual");
  return new PageEngine(renderer, makeSettings());
}

/** 构造一条 childList 突变记录 */
function rec(added: Node[] = [], removed: Node[] = []): MutationRecord {
  return {
    type: "childList",
    target: document.body,
    addedNodes: added,
    removedNodes: removed,
    oldValue: null,
    attributeName: null,
    attributeNamespace: null,
    previousSibling: null,
    nextSibling: null,
  } as unknown as MutationRecord;
}

/** 直接触发 onMutations（不经真实 MutationObserver，避免 jsdom 微任务时序噪声） */
function feed(observer: PageObserver, records: MutationRecord[]): void {
  (observer as unknown as { onMutations: (r: MutationRecord[]) => void }).onMutations(records);
}

/** 等防抖窗口过去、run() 消费完 addedRoots 并把扫描结果送进提取/调度 */
async function waitDebounce(): Promise<void> {
  await new Promise((r) => setTimeout(r, 450));
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
}

/** 汇总所有 translate 请求的 texts（扁平化）。mock.calls 每行是参数数组，msg 在 c[0] */
function allRequestedTexts(): string[] {
  const out: string[] = [];
  for (const c of sendMessage.mock.calls) {
    const msg = c[0] as { type?: string; texts?: string[] };
    if (msg?.type === "translate" && msg.texts) out.push(...msg.texts);
  }
  return out;
}

describe("onMutations 收集全部外部记录（B3-1：首条外部记录后不得 return）", () => {
  it("同批两条外部记录各自带 addedNodes → 两个根都被收集", async () => {
    const engine = makeEngine();
    const observer = new PageObserver(engine);
    await engine.translateAll(); // 激活引擎（run() 在 state=off 时早退，不进提取/调度）
    await new Promise((r) => setTimeout(r, 100));
    const before = allRequestedTexts().length;

    const a = document.createElement("p");
    a.textContent = "Alpha branch paragraph";
    const b = document.createElement("p");
    b.textContent = "Beta branch paragraph";
    // 提前挂入 DOM，模拟「记录发生时节点已在树上」（root.closest 判定需要连接状态）
    document.body.append(a, b);

    feed(observer, [rec([a]), rec([b])]);
    await waitDebounce();

    // 修复前：第二条记录的根 b 被丢弃，"Beta branch paragraph" 不进扫描集合 → 漏译
    const texts = allRequestedTexts().slice(before);
    expect(texts).toContain("Alpha branch paragraph");
    expect(texts).toContain("Beta branch paragraph");
    observer.disconnect();
  });

  it("三条外部记录两条带同文本 → 同批去重后仅请求一次", async () => {
    const engine = makeEngine();
    const observer = new PageObserver(engine);
    await engine.translateAll();
    await new Promise((r) => setTimeout(r, 100));
    const before = allRequestedTexts().length;

    const p1 = document.createElement("p");
    p1.textContent = "Shared sentence";
    const p2 = document.createElement("p");
    p2.textContent = "Shared sentence";
    const empty = document.createElement("div"); // 无 addedNodes 的外部记录也要触发调度
    document.body.append(p1, p2, empty);

    feed(observer, [rec([p1]), rec([empty]), rec([p2])]);
    await waitDebounce();

    // 同文本两容器在请求层共享：texts 只出现一次（total 按容器计数，不在此断言）
    const texts = allRequestedTexts().slice(before);
    expect(texts.filter((t) => t === "Shared sentence").length).toBeLessThanOrEqual(1);
    observer.disconnect();
  });

  it("全部记录为自身产物 → 不调度（自激防线仍在）", async () => {
    const engine = makeEngine();
    const observer = new PageObserver(engine);
    await engine.translateAll();
    await new Promise((r) => setTimeout(r, 100));
    const calls = sendMessage.mock.calls.length;

    const wrap = document.createElement("div");
    wrap.className = "it-wrap";
    wrap.setAttribute("data-it-unit", "it-1");
    const trans = document.createElement("span");
    trans.className = "it-translated";
    trans.setAttribute("data-it-unit", "it-1");
    trans.textContent = "译文内容";
    wrap.append(trans);
    document.body.appendChild(wrap);

    feed(observer, [rec([wrap])]);
    await waitDebounce();

    expect(sendMessage.mock.calls.length).toBe(calls);
    observer.disconnect();
  });
});

describe("isOwnNode 收紧为自身判定（B3-2：不再 closest 爬祖先）", () => {
  let observer: PageObserver;
  beforeEach(() => {
    observer = new PageObserver(makeEngine());
  });
  afterEach(() => observer.disconnect());

  /** 断言：单条记录只含 node 时被判定为外部（触发收集而非忽略） */
  function expectExternal(node: Node): void {
    const obs = observer as unknown as { isOwnRecord: (r: MutationRecord) => boolean };
    expect(obs.isOwnRecord(rec([node]))).toBe(false);
  }
  /** 断言：单条记录只含 node 时被判定为自身产物 */
  function expectOwn(node: Node): void {
    const obs = observer as unknown as { isOwnRecord: (r: MutationRecord) => boolean };
    expect(obs.isOwnRecord(rec([node]))).toBe(true);
  }

  it("外部节点（无任何标记）→ 被收集", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    expectExternal(el);
  });

  it("我们产物节点（data-it-unit / it-translated / it-wrap / data-it-ui）→ 被忽略", () => {
    const trans = document.createElement("span");
    trans.className = "it-translated";
    trans.setAttribute("data-it-unit", "it-x");
    document.body.appendChild(trans);
    expectOwn(trans);

    const wrap = document.createElement("div");
    wrap.className = "it-wrap";
    document.body.appendChild(wrap);
    expectOwn(wrap);

    const ui = document.createElement("div");
    ui.setAttribute("data-it-ui", "");
    document.body.appendChild(ui);
    expectOwn(ui);
  });

  it("外部节点即使被我们的产物包裹/包含 → 仍判为外部（回归点：原 closest 爬祖先会误判）", () => {
    // 站点把我们整个译文块包进它自己的新容器，随后该容器的插入记录到达
    const outer = document.createElement("div");
    const wrap = document.createElement("div");
    wrap.className = "it-wrap";
    wrap.setAttribute("data-it-unit", "it-y");
    outer.appendChild(wrap);
    document.body.appendChild(outer);
    expectExternal(outer);
  });

  it("产物内部文本节点 → 被忽略（parentElement 带 it-translated）", () => {
    const trans = document.createElement("span");
    trans.className = "it-translated";
    trans.setAttribute("data-it-unit", "it-z");
    trans.textContent = "填充的译文";
    document.body.appendChild(trans);
    const textNode = trans.firstChild as Text;
    expectOwn(textNode);
  });

  it("非译文元素内的文本节点（外部）→ 被收集", () => {
    const p = document.createElement("p");
    p.textContent = "site text";
    document.body.appendChild(p);
    expectExternal(p.firstChild as Text);
  });

  it("混合记录（同一记录里既有自产又有外部节点）→ 按外部处理，外部节点进扫描集合", async () => {
    const engine = makeEngine();
    const mixed = new PageObserver(engine);
    await engine.translateAll();
    await new Promise((r) => setTimeout(r, 100));
    const before = allRequestedTexts().length;

    const external = document.createElement("p");
    external.textContent = "Mixed record paragraph";
    const own = document.createElement("span");
    own.className = "it-translated";
    own.setAttribute("data-it-unit", "it-m");
    document.body.append(external, own);

    feed(mixed, [rec([own, external])]);
    await waitDebounce();

    const texts = allRequestedTexts().slice(before);
    expect(texts).toContain("Mixed record paragraph");
    mixed.disconnect();
  });

  it("仅 removedNodes 的外部记录（无 addedNodes）→ 仍调度（全量扫描兜底）", async () => {
    const engine = makeEngine();
    const rm = new PageObserver(engine);
    await engine.translateAll();
    await new Promise((r) => setTimeout(r, 100));
    const before = allRequestedTexts().length;
    const gone = document.createElement("p");
    gone.textContent = "To be removed paragraph";
    document.body.appendChild(gone);

    feed(rm, [rec([], [gone])]);
    await waitDebounce();

    // addedRoots 为空 → run 走全量扫描兜底路径，扫描出页面上的段落并发起请求
    expect(allRequestedTexts().length).toBeGreaterThan(before);
    rm.disconnect();
  });
});
