/**
 * e2e 冒烟：playwright（persistent context + Chromium 新 headless）加载 dist/ 扩展，
 * 拦截免费通道 API 返回固定译文，走一遍「翻译 → 译文出现 → 切模式 → 还原」核心链路。
 * 需要 `npm run build` 先产出 dist/ 与 playwright chromium；无浏览器环境时自动跳过。
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type BrowserContext, type Page } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");

const TEST_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"></head>
<body>
  <h1>E2E Smoke Header</h1>
  <p id="para">This paragraph exists to be translated by the extension.</p>
  <button id="ctrl">Click me</button>
</body></html>`;

let browserAvailable = false;
let context: BrowserContext | undefined;
let server: Server | undefined;
let baseUrl = "";

beforeAll(async () => {
  // 测试页 http 服务：content_scripts只匹配 http(s)，data: URL 不会注入
  server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(TEST_PAGE);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}/`;

  if (process.env.SKIP_E2E) return;
  try {
    // MV3 扩展必须用 persistent context + Chromium 新 headless（channel "chromium"）
    context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "e2e-it-")), {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`],
    });
    browserAvailable = true;
  } catch {
    browserAvailable = false; // 无浏览器环境（CI 未装）：跳过
  }
}, 120_000);

afterAll(async () => {
  await context?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

async function freshPage(): Promise<Page> {
  if (!browserAvailable || !context) throw new Error("SKIP");
  // 通过扩展 SW 把默认 API 切到 googlefree（免 Key，端点可被 route mock）
  const deadline = Date.now() + 20_000;
  let sw = context.serviceWorkers().find((w) => w.url().includes("service-worker-loader"));
  while (!sw && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    sw = context.serviceWorkers().find((w) => w.url().includes("service-worker-loader"));
  }
  if (!sw) throw new Error("SKIP");
  await sw.evaluate(async () => {
    const { getSettings, saveSettings } = await import("./assets/storage-BtNi0PCW.js");
    const s = await getSettings();
    s.api.format = "googlefree";
    await saveSettings(s);
  }).catch(async () => {
    // chunk 文件名变化时兜底：直接用 chrome.storage 写最小设置（读取侧会合并默认值）
    await sw!.evaluate(async () => {
      const stored = await chrome.storage.local.get("settings");
      const s = stored.settings ?? {};
      s.api = { ...(s.api ?? {}), format: "googlefree" };
      await chrome.storage.local.set({ settings: s });
    });
  });
  // 免费通道 mock：任何 translate.googleapis.com 请求都返回固定译文
  await context.route("**://translate.googleapis.com/**", (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get("q") ?? "";
    const translated = `「${q}」`;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([[[translated, q, null, null, 10]], null, "en"]),
    });
  });
  const p = await context.newPage();
  await p.goto(baseUrl);
  await p.waitForSelector(".it-fab", { timeout: 30_000 });
  return p;
}

/** 展开工具条并点「翻译」，等译文真正填充（.it-done；占位是 reserve 阶段就有的 .it-pending） */
async function translatePage(p: Page): Promise<void> {
  await p.click(".it-fab");
  await p.waitForSelector(".it-toggle", { timeout: 5000 });
  await p.click(".it-toggle");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const done = await p.evaluate(() => document.querySelectorAll(".it-translated.it-done").length);
    if (done > 0) return;
    if (Math.random() < 0.1) {
      const status = await p.evaluate(() => document.querySelector(".it-status")?.textContent ?? "");
      console.log("E2E POLL:", JSON.stringify({ done, status }));
    }
    await p.waitForTimeout(1000);
  }
  const status = await p.evaluate(() => document.querySelector(".it-status")?.textContent ?? "");
  console.log("E2E TIMEOUT STATUS:", status);
  const probe = await p.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "check-cache", targetLang: "zh-CN", texts: ["x"] }, (r) =>
          resolve({ lastErr: chrome.runtime.lastError?.message ?? null, res: r })
        );
      })
  );
  console.log("E2E PROBE:", JSON.stringify(probe));
  throw new Error("translation never completed");
}

describe("e2e 冒烟（加载 dist 扩展）", () => {
  it("翻译 → 译文出现 → 状态完成 →还原", async () => {
    if (!browserAvailable) return;
    const p = await freshPage();
    await translatePage(p);

    // 双语模式：译文元素包含 mock 译文，原文仍在
    const body = await p.evaluate(() => document.body.textContent ?? "");
    expect(body).toContain("This paragraph exists to be translated");
    expect(body).toContain("「This paragraph exists to be translated by the extension.」");

    // 状态行显示完成（i18n 中英都匹配）
    await p.waitForFunction(
      () => {
        const s = document.querySelector(".it-status")?.textContent ?? "";
        return s.includes("段完成") || s.includes("done");
      },
      undefined,
      { timeout: 15_000 }
    );

    // 还原：译文元素移除、原文恢复
    await p.click(".it-toggle");
    await p.waitForSelector(".it-translated", { state: "detached", timeout: 15_000 });
    const restored = await p.textContent("#para");
    expect(restored).toContain("This paragraph exists to be translated");
    expect(restored).not.toContain("「This paragraph");
  }, 180_000);

  it("显示模式切换：双语 → 仅译文（原文隐藏）→ 双语（原文恢复）", async () => {
    if (!browserAvailable) return;
    const p = await freshPage();
    await translatePage(p);

    // modeSelect 是 .it-panel 里第一个 select（grip/toggle 不是 select）
    const modeSelect = p.locator(".it-panel select").nth(0);
    await modeSelect.selectOption("translated");
    await p.waitForFunction(
      () => document.querySelectorAll("[data-it-orig-hidden]").length > 0,
      undefined,
      { timeout: 10_000 }
    );

    await modeSelect.selectOption("bilingual");
    await p.waitForFunction(
      () => document.querySelectorAll("[data-it-orig-hidden]").length === 0,
      undefined,
      { timeout: 10_000 }
    );
    expect(true).toBe(true);
  }, 180_000);

  it("service worker 已启动", async () => {
    if (!browserAvailable) return;
    if (!context) throw new Error("SKIP");
    // SW 异步注册：轮询而非 waitForEvent（可能在我们监听前就已启动）
    const deadline = Date.now() + 20_000;
    while (context.serviceWorkers().length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const swUrls = context.serviceWorkers().map((w) => w.url());
    expect(swUrls.some((u) => u.includes("service-worker-loader.js"))).toBe(true);
  }, 60_000);
});
