/**
 * e2e 冒烟：playwright（persistent context + Chromium 新 headless）加载 dist/ 扩展，
 * 拦截免费通道 API 返回固定译文，走一遍「翻译 → 译文出现 → 切模式 → 还原」核心链路。
 * 需要 `npm run build` 先产出 dist/ 与 playwright chromium；
 * 无浏览器/dist 或设置 SKIP_E2E=1 时用 it.skipIf 跳过（报告中显示为 skipped 而非 passed）。
 * 设 CI_ASSERT_E2E=1（CI 断言模式）时守卫条件不满足直接失败而非 skip：
 * 保证 e2e 在 CI 上要么真实运行、要么显式红灯，绝不静默跳过。
 */
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type BrowserContext, type Page } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");

/** 逐条计算守卫条件（跳过原因便于排查）。 */
const guardReasons = (): string[] => {
  if (process.env.SKIP_E2E) return ["SKIP_E2E=1 已设置"];
  const reasons: string[] = [];
  if (!browserAvailable) reasons.push("playwright chromium 探测失败（未安装或 launch 异常，见上方 warn）");
  if (!existsSync(distDir)) reasons.push("dist/ 不存在（需先 npm run build）");
  return reasons;
};

/** 守卫条件：浏览器可用且 dist 存在才真正跑；SKIP_E2E=1 时同样跳过。
 * CI_ASSERT_E2E=1（CI 断言模式）时条件不满足直接 throw，让 CI 显式红灯而非静默 skip。 */
const canRunE2e = (): boolean => {
  if (process.env.CI_ASSERT_E2E === "1") {
    const reasons = guardReasons();
    if (reasons.length > 0) {
      throw new Error(
        `[CI_ASSERT_E2E] e2e 守卫条件不满足，拒绝静默跳过：\n  - ${reasons.join("\n  - ")}\n` +
          "CI 上 e2e 必须真实运行（Install Playwright Chromium + Build 均已执行），请排查上方步骤。"
      );
    }
    return true;
  }
  return !process.env.SKIP_E2E && browserAvailable && existsSync(distDir);
};

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

// 浏览器探测必须在模块顶层完成（而非 beforeAll）：it.skipIf 的条件在收集阶段求值，
// 早于 beforeAll。SKIP_E2E=1 时直接不探测；launch 失败则置 false 并 warn 原因便于 CI 排查。
if (!process.env.SKIP_E2E) {
  try {
    // MV3 扩展必须用 persistent context + Chromium 新 headless（channel "chromium"）
    context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "e2e-it-")), {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`],
    });
    browserAvailable = true;
  } catch (err) {
    browserAvailable = false; // 无浏览器环境（CI 未装）：用例经 it.skipIf 跳过并在报告中可见
    console.warn(
      "[e2eSmoke] browser probe failed, e2e cases will be skipped:",
      err instanceof Error ? err.message : err
    );
  }
}

beforeAll(async () => {
  // 测试页 http 服务：content_scripts只匹配 http(s)，data: URL 不会注入
  server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(TEST_PAGE);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}/`;

  if (!browserAvailable) return;
  // 免费通道 mock 在 context 级注册一次（覆盖所有用例新开的页面，不随用例叠加）：
  // 任何 translate.googleapis.com 请求都返回固定译文
  await context!.route("**://translate.googleapis.com/**", (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get("q") ?? "";
    const translated = `「${q}」`;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([[[translated, q, null, null, 10]], null, "en"]),
    });
  });
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
  // 通过扩展 SW 把默认 API 切到 googlefree（免 Key，端点已被 context 级 route mock）。
  // 直接写 chrome.storage 的最小设置：读取侧 getSettings 按段合并默认值。
  // （此前先 import 存储 chunk 再调 saveSettings，但 chunk 文件名带内容哈希，构建一变即失效）
  await sw.evaluate(async () => {
    const stored = await chrome.storage.local.get("settings");
    const s = (stored.settings ?? {}) as { api?: Record<string, unknown> };
    s.api = { ...(s.api ?? {}), format: "googlefree" };
    await chrome.storage.local.set({ settings: s });
  });
  const p = await context.newPage();
  await p.goto(baseUrl);
  await p.waitForSelector(".it-fab", { timeout: 30_000 });
  return p;
}

/** 展开工具条并点「翻译」，等译文真正填充（.it-done；占位是 reserve 阶段就有的 .it-pending）。
 *  面板可能已是展开态（如总开关关闭→重开后保留展开）：红点此时被 CSS 隐藏，直接点「翻译」。 */
async function translatePage(p: Page): Promise<void> {
  if (
    await p
      .locator(".it-fab")
      .isVisible()
      .catch(() => false)
  )
    await p.click(".it-fab");
  await p.waitForSelector(".it-toggle", { timeout: 5000 });
  await p.click(".it-toggle");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const done = await p.evaluate(() => document.querySelectorAll(".it-translated.it-done").length);
    if (done > 0) return;
    if (Math.random() < 0.1) {
      const status = await p.evaluate(
        () => document.querySelector(".it-status")?.textContent ?? ""
      );
      console.log("E2E POLL:", JSON.stringify({ done, status }));
    }
    await p.waitForTimeout(1000);
  }
  const status = await p.evaluate(() => document.querySelector(".it-status")?.textContent ?? "");
  console.log("E2E TIMEOUT STATUS:", status);
  const probe = await p.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: "check-cache", targetLang: "zh-CN", texts: ["x"] },
          (r) => resolve({ lastErr: chrome.runtime.lastError?.message ?? null, res: r })
        );
      })
  );
  console.log("E2E PROBE:", JSON.stringify(probe));
  throw new Error("translation never completed");
}

describe("e2e 冒烟（加载 dist 扩展）", () => {
  /** 模拟 popup 开关：SW 直写 chrome.storage.local 的 enabled 字段。
   *  popup 保存走的是同一个存储通道，storage.onChanged 广播到所有 frame。 */
  async function setEnabledViaSw(v: boolean): Promise<void> {
    if (!context) throw new Error("SKIP");
    const sw = context.serviceWorkers().find((w) => w.url().includes("service-worker-loader"));
    if (!sw) throw new Error("SKIP");
    await sw.evaluate(async (val) => {
      const stored = await chrome.storage.local.get("settings");
      const s = (stored.settings ?? {}) as Record<string, unknown>;
      s.enabled = val;
      await chrome.storage.local.set({ settings: s });
    }, v);
  }

  it.skipIf(!canRunE2e())("总开关：关闭立即还原页面并收起工具条；重新开启恢复翻译（无需刷新）", async () => {
    const p = await freshPage();
    await translatePage(p);
    expect(
      await p.evaluate(() => document.querySelectorAll(".it-translated").length)
    ).toBeGreaterThan(0);

    // 关闭：已译内容即时还原、悬浮工具条收起（storage.onChanged 实时生效，不刷新页面）
    await setEnabledViaSw(false);
    await p.waitForFunction(
      () =>
        document.querySelectorAll(".it-translated").length === 0 &&
        !!document.querySelector(".it-toolbar")?.classList.contains("it-toolbar-sensitive"),
      undefined,
      { timeout: 15_000 }
    );
    // 关闭后短暂等待：观察器/动态入口不应再产生任何译文
    await p.waitForTimeout(1500);
    expect(await p.evaluate(() => document.querySelectorAll(".it-translated").length)).toBe(0);

    // 重新开启：工具条恢复，且手动翻译照常可用（自动翻译默认关，不自动重译）
    await setEnabledViaSw(true);
    await p.waitForFunction(
      () => !document.querySelector(".it-toolbar")?.classList.contains("it-toolbar-sensitive"),
      undefined,
      { timeout: 15_000 }
    );
    await translatePage(p); // 复用完整链路：展开工具条 → 点翻译 → 译文出现
    expect(
      await p.evaluate(() => (document.body.textContent ?? "").includes("by the extension.」"))
    ).toBe(true);
  }, 180_000);

  it.skipIf(!canRunE2e())("翻译 → 译文出现 → 状态完成 →还原", async () => {
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

  it.skipIf(!canRunE2e())("显示模式切换：双语 → 仅译文（原文原位替换）→ 双语（原文恢复）", async () => {
    const p = await freshPage();
    await translatePage(p);

    // modeSelect 是 .it-panel 里第一个 select（grip/toggle 不是 select）
    const modeSelect = p.locator(".it-panel select").nth(0);
    await modeSelect.selectOption("translated");
    // 仅译文：段落原文被原位替换为译文（#para 文字以译文引导符开头；
    // 译文元素本身进入隐藏态，可见译文就在原元素里，链接/结构保留）
    await p.waitForFunction(
      () => {
        const para = document.querySelector("#para");
        return (
          !!para &&
          (para.textContent ?? "").trimStart().startsWith("「") &&
          document.querySelectorAll(".it-translated.it-translated-hidden").length > 0
        );
      },
      undefined,
      { timeout: 10_000 }
    );

    await modeSelect.selectOption("bilingual");
    await p.waitForFunction(
      () => {
        const para = document.querySelector("#para");
        return (
          !!para &&
          (para.textContent ?? "").trimStart().startsWith("This paragraph") &&
          document.querySelectorAll(".it-translated.it-translated-hidden").length === 0
        );
      },
      undefined,
      { timeout: 10_000 }
    );
    // 双语结构完整：原文块回到 .it-wrap 内的 .it-orig 位置，可见译文元素仍在身旁。
    // 上面的 waitForFunction 只证明「无隐藏译文 + 原文开头是英文」——若切回双语时
    // 译文元素被误删，两个条件照样满足；这里补上结构校验防止该回归。
    const bilingual = await p.evaluate(() => {
      const orig = document.querySelector("#para");
      const wrap = orig?.closest(".it-wrap") ?? null;
      const trans = wrap?.querySelector(":scope > .it-translated.it-done") ?? null;
      return {
        origInWrap: !!orig && !!wrap,
        hasVisibleTrans: !!trans,
        transText: (trans?.textContent ?? "").trim(),
      };
    });
    expect(bilingual.origInWrap).toBe(true);
    expect(bilingual.hasVisibleTrans).toBe(true);
    expect(bilingual.transText).toContain("by the extension.」");
  }, 180_000);

  it.skipIf(!canRunE2e())(
    "OpenAI 兼容通道（SSE 流式）：划词气泡流式渲染，译文为各 delta 拼接",
    async () => {
      // Playwright route.fulfill 的 body 只接受 string|Buffer（无法分段推送），
      // 改用本地 node 服务真实分段写 SSE：每个事件的 JSON 拆成两次 TCP write，
      // 让 postSSE 的跨 chunk 缓冲重组在真实浏览器网络栈里被覆盖。
      // OpenAI 兼容请求形状（src/background/providers/openai.ts）：
      //   POST {baseUrl}/chat/completions，Authorization: Bearer <key>，body.stream=true；
      //   SSE 响应 data: {"choices":[{"delta":{"content":"…"}}]}\n\n 多段 + data: [DONE]
      const seen: { authorization?: string; body?: string } = {};
      const sseServer = createServer((req, res) => {
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c.toString("utf-8")));
        req.on("end", () => {
          seen.authorization = req.headers.authorization;
          seen.body = raw;
          let parsed: { stream?: boolean };
          try {
            parsed = JSON.parse(raw) as { stream?: boolean };
          } catch {
            parsed = {};
          }
          if (!parsed.stream) {
            // 防御：扩展若走了非流式回退（期望 JSON 响应），让它显式失败而非误解析 SSE
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "e2e mock requires stream:true" } }));
            return;
          }
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const deltas = ["星河低语，", "晚风", "轻拂。"];
          void (async () => {
            for (const seg of deltas) {
              const payload = JSON.stringify({ choices: [{ delta: { content: seg } }] });
              // 单个事件从 JSON 中间切开分两次 write：data 行跨 chunk 边界，
              // 浏览器 reader.read() 收到的是残缺事件，靠 postSSE 缓冲拼回
              const half = Math.ceil(payload.length / 2);
              res.write(`data: ${payload.slice(0, half)}`);
              await new Promise((r) => setTimeout(r, 25));
              res.write(`${payload.slice(half)}\n\n`);
              await new Promise((r) => setTimeout(r, 25));
            }
            res.write("data: [DONE]\n\n");
            res.end();
          })().catch(() => res.end());
        });
      });
      await new Promise<void>((resolve) => sseServer.listen(0, "127.0.0.1", resolve));
      const ssePort = (sseServer.address() as { port: number }).port;
      const sseBase = `http://127.0.0.1:${ssePort}/v1`;

      try {
        const p = await freshPage();
        // 设置页等价路径：把 API 切到 openai 兼容通道（storage.onChanged 失效 SW 侧设置缓存）。
        // apiKey 明文直写安全：decryptApiKey 对非 Base64 字符集（含 "-"）幂等原样返回
        const sw = context!.serviceWorkers().find((w) => w.url().includes("service-worker-loader"));
        if (!sw) throw new Error("SKIP");
        await sw.evaluate(
          async (cfg) => {
            const stored = await chrome.storage.local.get("settings");
            const s = (stored.settings ?? {}) as { api?: Record<string, unknown> };
            s.api = { ...(s.api ?? {}), ...cfg };
            await chrome.storage.local.set({ settings: s });
          },
          { format: "openai", baseUrl: sseBase, apiKey: "sk-e2e-mock-key", model: "mock-e2e-model" }
        );
        await p.waitForTimeout(200); // onChanged 失效 cachedSettings 先于翻译请求

        // 真实用户路径：鼠标拖选段落 → translateOnSelect 默认开 → 划词气泡发起流式翻译
        //（整页翻译路径不传 stream.onDelta 走非流式；SSE 消费方就是划词气泡 Port 通道）
        const box = await p.locator("#para").boundingBox();
        if (!box) throw new Error("#para not visible");
        await p.mouse.move(box.x + 2, box.y + box.height / 2);
        await p.mouse.down();
        await p.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 5 });
        await p.mouse.up();

        await p.waitForSelector(".it-bubble", { timeout: 10_000 });
        // 流式完成：气泡主体渲染出各 delta 拼接的完整文本（loading 态是「翻译中…」占位；
        // 若 SSE 解析错误，最终文本不会等于三段 delta 之和）
        await p.waitForFunction(
          () => (document.querySelector(".it-bubble-body")?.textContent ?? "") === "星河低语，晚风轻拂。",
          undefined,
          { timeout: 10_000 }
        );

        // 请求形状：Bearer 鉴权头 + stream:true + 模型名 + 选中文本作为 user 消息
        expect(seen.authorization).toBe("Bearer sk-e2e-mock-key");
        const reqBody = JSON.parse(seen.body ?? "{}") as {
          stream?: boolean;
          model?: string;
          messages?: Array<{ role: string; content: string }>;
        };
        expect(reqBody.stream).toBe(true);
        expect(reqBody.model).toBe("mock-e2e-model");
        const user = reqBody.messages?.find((m) => m.role === "user")?.content ?? "";
        expect(user).toContain("translated by the extension");
      } finally {
        await new Promise<void>((resolve) => sseServer.close(() => resolve()));
      }
    },
    120_000
  );

  it.skipIf(!canRunE2e())("service worker 已启动", async () => {
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
