// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, uninstallChromeMock } from "./helpers/chromeMock";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** popup 页 UI 冒烟测试：验证总开关写入 storage、白/黑名单操作落盘、消息形状与路由匹配。
 *  popup 是用户最高频入口（总开关 + 快捷配置），此前零测试。 */

const popupHtml = readFileSync(resolve(__dirname, "../src/popup/index.html"), "utf-8");

/** 装配 popup 页：注入 HTML 后动态 import main.ts（顶层注册监听器并执行 loadForm/initSite）。
 *  注意：main.ts 顶层代码只在首次 import 时执行，必须 vi.resetModules() 强制重新求值。 */
async function mountPopupPage(): Promise<void> {
  vi.resetModules();
  document.documentElement.innerHTML = popupHtml;
  await import("../src/popup/main");
}

describe("popup 页 UI 冒烟", () => {
  beforeEach(async () => {
    // jsdom 缺 CSS.escape（popup 可能间接用到）
    if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== "function") {
      (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS = {
        escape: (v: string) => v.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`),
      };
    }
    // popup 需要 chrome.tabs.query（initSite 读当前标签页）和 chrome.i18n（文案语言）
    installChromeMock({
      extra: {
        tabs: {
          query: async () => [{ url: "https://example.com/page" }],
        },
        i18n: { getUILanguage: () => "zh-CN" },
      },
    });
    await mountPopupPage();
  });

  afterEach(() => {
    uninstallChromeMock();
    vi.restoreAllMocks();
  });

  it("总开关切换写入 storage.enabled 并同步 UI 提示", async () => {
    const toggle = document.getElementById("p-enabled") as HTMLInputElement;
    expect(toggle.checked).toBe(true); // 默认开启（DEFAULT_SETTINGS.enabled = true）

    // 关闭
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      const status = document.getElementById("p-status") as HTMLElement;
      expect(status.textContent).toMatch(/已关闭|已停用/);
    });
    let settings = (await chrome.storage.local.get("settings")).settings as { enabled?: boolean };
    expect(settings.enabled).toBe(false);

    // 重新开启
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      const status = document.getElementById("p-status") as HTMLElement;
      expect(status.textContent).toMatch(/已开启|已启用/);
    });
    settings = (await chrome.storage.local.get("settings")).settings as { enabled?: boolean };
    expect(settings.enabled).toBe(true);
  });

  it("「加入白名单」把当前站点写入 storage.sites.whitelist", async () => {
    (document.getElementById("btn-whitelist") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      const status = document.getElementById("p-status") as HTMLElement;
      expect(status.textContent).toMatch(/白名单/);
    });
    const settings = (await chrome.storage.local.get("settings")).settings as {
      sites?: { whitelist?: string[]; blacklist?: string[] };
    };
    expect(settings.sites?.whitelist).toContain("example.com");
    // 从对立名单移除的语义（当前为空名单，无实际移除但字段应存在）
    expect(settings.sites?.blacklist).toBeDefined();
  });

  it("「加入黑名单」把当前站点写入 blacklist 并从 whitelist 移除", async () => {
    // 先加白名单
    (document.getElementById("btn-whitelist") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect((document.getElementById("p-status") as HTMLElement).textContent).toMatch(/白名单/);
    });
    // 再加黑名单
    (document.getElementById("btn-blacklist") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect((document.getElementById("p-status") as HTMLElement).textContent).toMatch(/黑名单/);
    });
    const settings = (await chrome.storage.local.get("settings")).settings as {
      sites?: { whitelist?: string[]; blacklist?: string[] };
    };
    expect(settings.sites?.blacklist).toContain("example.com");
    expect(settings.sites?.whitelist).not.toContain("example.com");
  });
});
