// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, uninstallChromeMock } from "./helpers/chromeMock";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** options 页 UI 冒烟测试：加载真实 HTML、安装 chrome mock、动态 import 装配脚本。
 *  验证 UI 保存走 SETTING_RANGES 钳制、导入非法文件有可见反馈、导出成功有状态提示。
 *  历史上这类"UI 粘合层"最容易悄悄漂移，此前零测试。 */

const optionsHtml = readFileSync(resolve(__dirname, "../src/options/index.html"), "utf-8");

/** 装配 options 页：注入 HTML 后动态 import main.ts（其顶层 init() 依赖 DOMContentLoaded
 *  之后的 DOM，jsdom 在 import 时 readyState 已是 complete，直接同步执行）。
 *  注意：main.ts 顶层 init() 只在首次 import 时执行，三个用例共享模块缓存会导致后续
 *  用例的新 DOM 没有监听器——必须 vi.resetModules() 强制重新求值。 */
async function mountOptionsPage(): Promise<void> {
  vi.resetModules();
  document.documentElement.innerHTML = optionsHtml;
  await import("../src/options/main");
}

describe("options 页 UI 冒烟", () => {
  beforeEach(async () => {
    // jsdom 缺 CSS.escape，options/main.ts:418 需要
    if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== "function") {
      (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS = {
        escape: (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`),
      };
    }
    installChromeMock();
    await mountOptionsPage();
  });

  afterEach(() => {
    uninstallChromeMock();
    vi.restoreAllMocks();
  });

  it("保存时越界超时值被钳制到 SETTING_RANGES 区间", async () => {
    const timeoutInput = document.getElementById("timeout") as HTMLInputElement;
    expect(timeoutInput).toBeTruthy();
    // 越界：超时上限 300 秒
    timeoutInput.value = "9999";
    (document.getElementById("btn-save") as HTMLButtonElement).click();
    // 等待 readForm → saveSettings 完成（readForm 内部有一次 getSettings 往返）
    await vi.waitFor(() => {
      const status = document.getElementById("status") as HTMLElement;
      expect(status.textContent).toMatch(/已保存/);
    });
    // 落盘的 timeoutMs 应为 300 * 1000，而非 9999 * 1000
    const settings = (await chrome.storage.local.get("settings")).settings as {
      api?: { timeoutMs?: number };
    };
    expect(settings.api?.timeoutMs).toBe(300_000);
  });

  it("导入非法 JSON 文件时状态栏显示导入失败且不破坏现有设置", async () => {
    // 先保存一次有效设置作为基线
    (document.getElementById("btn-save") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect((document.getElementById("status") as HTMLElement).textContent).toMatch(/已保存/);
    });
    const before = await chrome.storage.local.get("settings");

    // 构造一个非法文件（JSON 语法错误）
    const fileInput = document.getElementById("import-file") as HTMLInputElement;
    const badFile = new File(["{ not valid json"], "bad.json", { type: "application/json" });
    Object.defineProperty(fileInput, "files", { value: [badFile], configurable: true });
    fileInput.dispatchEvent(new Event("change"));

    await vi.waitFor(() => {
      const status = document.getElementById("status") as HTMLElement;
      expect(status.textContent).toMatch(/导入失败/);
    });
    // 现有设置未被清空
    const after = await chrome.storage.local.get("settings");
    expect(after.settings).toEqual(before.settings);
  });

  it("导出成功后状态栏显示导出提示", async () => {
    (document.getElementById("btn-export") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      const status = (document.getElementById("status") as HTMLElement).textContent;
      expect(status).toMatch(/已导出/);
    });
  });

  it("保存不动未编辑的站点文本域：popup 期间加入的白名单不被陈旧表单回滚（修复1）", async () => {
    // 先保存一次建立存储基线（否则 mock storage 为空）
    (document.getElementById("btn-save") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect((document.getElementById("status") as HTMLElement).textContent).toMatch(/已保存/);
    });
    // 模拟页面打开后 popup 另行写入白名单（options 表单的 textarea 不知情）
    const stored = (await chrome.storage.local.get("settings")).settings as {
      sites: { whitelist: string[]; blacklist: string[] };
    };
    stored.sites.whitelist = ["popup-added.example.com"];
    await chrome.storage.local.set({ settings: stored });

    // 用户没有碰站点文本域，直接点「保存设置」
    (document.getElementById("btn-save") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect((document.getElementById("status") as HTMLElement).textContent).toMatch(/已保存/);
    });

    const after = (await chrome.storage.local.get("settings")).settings as {
      sites: { whitelist: string[] };
    };
    expect(after.sites.whitelist).toContain("popup-added.example.com");
  });

  it("用户编辑过白名单文本域时保存仍采用表单值（修复1不破坏正常编辑）", async () => {
    const ta = document.getElementById("whitelist") as HTMLTextAreaElement;
    ta.value = "edited.example.com";
    (document.getElementById("btn-save") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect((document.getElementById("status") as HTMLElement).textContent).toMatch(/已保存/);
    });
    const after = (await chrome.storage.local.get("settings")).settings as {
      sites: { whitelist: string[] };
    };
    expect(after.sites.whitelist).toContain("edited.example.com");
  });

  it("备用通道临时切免费后保存不清空原第三方配置（修复3）", async () => {
    // 先保存一次建立存储基线，再写入 openai 备用配置
    (document.getElementById("btn-save") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect((document.getElementById("status") as HTMLElement).textContent).toMatch(/已保存/);
    });
    const stored = (await chrome.storage.local.get("settings")).settings as {
      backupApi?: { format: string; baseUrl: string; apiKey: string; model: string };
    };
    stored.backupApi = { format: "openai", baseUrl: "https://api.b.test/v1", apiKey: "", model: "b-model" };
    await chrome.storage.local.set({ settings: stored });
    // 重新挂载页面，让表单载入备用配置
    await mountOptionsPage();

    // 用户临时把备用通道切到 Google 免费（输入框只是禁用不清空），直接保存
    const backupFormat = document.getElementById("backup-format") as HTMLSelectElement;
    backupFormat.value = "googlefree";
    (document.getElementById("btn-save") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect((document.getElementById("status") as HTMLElement).textContent).toMatch(/已保存/);
    });

    const after = (await chrome.storage.local.get("settings")).settings as {
      backupApi?: { baseUrl: string; model: string };
    };
    // 备用连接字段保留原值（googlefree provider 会忽略它们）
    expect(after.backupApi?.baseUrl).toBe("https://api.b.test/v1");
    expect(after.backupApi?.model).toBe("b-model");
  });

  it("站点规则 JSON 有笔误时连接测试仍可进行且不被报成测试失败（修复5）", async () => {
    // 站点规则文本域粘了格式错误的 JSON
    (document.getElementById("site-rules") as HTMLTextAreaElement).value = "{ broken json";
    // 切到免费通道（无需 BaseURL/Key），让连接测试真正发出去（chromeMock 回 { ok: true }）
    (document.getElementById("api-format") as HTMLSelectElement).value = "googlefree";
    (document.getElementById("btn-test") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      const status = (document.getElementById("status") as HTMLElement).textContent;
      // 测试路径不解析站点规则：既不报站点规则错误，也能给出连接自身的结论
      expect(status).not.toMatch(/站点规则/);
      expect(status).toMatch(/连接成功/);
    });
  });

  it("测试按钮在 await 前同步禁用，防双击双发（修复4）", async () => {
    const btn = document.getElementById("btn-test") as HTMLButtonElement;
    // 同步点击后立即检查：readApiForm 内部有 storage 往返，禁用必须发生在其之前
    btn.click();
    expect(btn.disabled).toBe(true);
    await vi.waitFor(() => {
      expect((document.getElementById("status") as HTMLElement).textContent).not.toBe("");
    });
    await vi.waitFor(() => expect(btn.disabled).toBe(false));
  });
});
