// @vitest-environment jsdom
/**
 * 点击触发组件（下拉菜单/弹出选项）的翻译覆盖：
 * 1. 这类组件的显隐常通过 style/class 切换，不产生 childList 突变，
 *    MutationObserver 收不到通知——观察器在点击后主动补一次扫描；
 * 2. 新插入 DOM 的菜单选项也能被观察器增量翻译；
 * 3. 菜单选项（button）以文本原位替换方式翻译，不破坏结构。
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
let observer: PageObserver | null = null;

beforeEach(() => {
  sendMessage = vi.fn(async (msg: { type: string; texts?: string[]; id?: string }) => {
    if (msg?.type === "translate") {
      return { id: msg.id, ok: true, results: (msg.texts ?? []).map((t) => `【译】${t}`) };
    }
    if (msg?.type === "check-cache") return { cachedCount: 0 };
    return undefined;
  });
  installChromeMock({ extra: { runtime: { sendMessage } } });
});

afterEach(() => {
  observer?.disconnect();
  observer = null;
  uninstallChromeMock();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
}

/** 轮询等待条件成立（与 sessionCancel / dedupeScheduling.test.ts 同惯例）：
 *  观察器防抖（300ms）+ 翻译往返是多层异步链，固定睡眠在慢 CI 上会提前返回造成
 *  假失败，且只能证明"550ms 内完成了"；改为轮询"要断言的终态是否出现"。
 *  轮询每 10ms 让出一次宏任务队列，防抖定时器与 sendMessage 往返都能推进。 */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("点击后出现的组件也要翻译", () => {
  it("style 切换显隐的下拉选项（无 DOM 突变）：点击后被补翻", async () => {
    document.body.innerHTML = `
      <p>Paragraph text here.</p>
      <div id="menu" style="display: none">
        <button>First option</button>
        <button>Second option</button>
      </div>
    `;
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    observer = new PageObserver(engine);
    await engine.translateAll();
    await flush();

    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>("#menu button"));
    expect(btns[0].textContent).toBe("First option"); // 隐藏时未翻译

    // 模拟点击展开：直接改 style 属性不产生 childList 突变，只能靠点击探测补扫
    (document.querySelector("#menu") as HTMLElement).style.display = "block";
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // 等终态：两个选项均被原位替换为译文（防抖 + 点击补扫 + 翻译往返全部完成）
    await waitFor(() => btns[0].textContent === "【译】First option" && btns[1].textContent === "【译】Second option");

    expect(btns[0].textContent).toBe("【译】First option");
    expect(btns[1].textContent).toBe("【译】Second option");
  });

  it("点击后新插入 DOM 的菜单选项：观察器增量翻译", async () => {
    document.body.innerHTML = `<p>Paragraph text here.</p>`;
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    observer = new PageObserver(engine);
    await engine.translateAll();
    await flush();

    // 模拟点击后菜单被动态插入
    const menu = document.createElement("ul");
    menu.id = "popup";
    menu.innerHTML = `<li><button>Edit item</button></li><li><button>Delete item</button></li>`;
    document.body.appendChild(menu);

    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>("#popup button"));
    // 等终态：新插入的菜单选项被观察器增量翻译
    await waitFor(() => btns[0].textContent === "【译】Edit item" && btns[1].textContent === "【译】Delete item");

    expect(btns[0].textContent).toBe("【译】Edit item");
    expect(btns[1].textContent).toBe("【译】Delete item");
  });

  it("未翻译的页面（state=off）：点击弹出的菜单不翻译", async () => {
    document.body.innerHTML = `
      <p>Paragraph text here.</p>
      <div id="menu" style="display: none"><button>First option</button></div>
    `;
    const engine = new PageEngine(new Renderer("bilingual"), makeSettings());
    observer = new PageObserver(engine);
    // 不调用 translateAll：页面处于未翻译状态

    (document.querySelector("#menu") as HTMLElement).style.display = "block";
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // 负向断言（state=off 不翻译）：等待的是"不应出现的终态"，无法轮询。
    // 必须真实跨过观察器防抖窗口（observer.ts DEBOUNCE_MS=300ms）+ 余量，让点击
    // 补扫的 run() 有充分机会执行并因 state=off 早退，"没翻"这一结论才有效；
    // 故保留受控真实短睡眠，替代原固定 550ms 魔法时长。
    await new Promise((r) => setTimeout(r, 400));
    await flush();

    expect(document.querySelector("#menu button")!.textContent).toBe("First option");
  });
});
