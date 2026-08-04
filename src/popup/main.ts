/** 弹窗：快捷 API 配置（免进设置页）+ 测试连接 + 保存 */
import type {
  TestConnectionRequestMessage,
  TestConnectionResponseMessage,
} from "../shared/messages";
import { getSettings, saveSettings } from "../shared/storage";
import type { ApiConfig, ApiFormat } from "../shared/types";

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`元素不存在: ${id}`);
  return el;
};

function setStatus(text: string, kind: "ok" | "err" | "" = ""): void {
  const el = $("p-status");
  el.textContent = text;
  el.className = `status ${kind}`.trim();
}

async function readApi(): Promise<ApiConfig> {
  const current = await getSettings();
  return {
    ...current.api, // 保留温度/超时/并发等已配置值
    format: ($("p-format") as HTMLSelectElement).value as ApiFormat,
    baseUrl: ($("p-base-url") as HTMLInputElement).value.trim(),
    apiKey: ($("p-api-key") as HTMLInputElement).value.trim(),
    model: ($("p-model") as HTMLInputElement).value.trim(),
  };
}

async function loadForm(): Promise<void> {
  const s = await getSettings();
  ($("p-format") as HTMLSelectElement).value = s.api.format;
  ($("p-base-url") as HTMLInputElement).value = s.api.baseUrl;
  ($("p-api-key") as HTMLInputElement).value = s.api.apiKey;
  ($("p-model") as HTMLInputElement).value = s.api.model;
}

($("version")).textContent = `v${chrome.runtime.getManifest().version}`;

$("p-test").addEventListener("click", async () => {
  const api = await readApi();
  if (!api.baseUrl || !api.model) {
    setStatus("请填写 BaseURL 和模型", "err");
    return;
  }
  const btn = $("p-test") as HTMLButtonElement;
  btn.disabled = true;
  setStatus("测试中…");
  try {
    const req: TestConnectionRequestMessage = { type: "test-connection", id: crypto.randomUUID(), api };
    const res = (await chrome.runtime.sendMessage(req)) as TestConnectionResponseMessage;
    setStatus(
      res.ok ? `连接成功：${res.message ?? ""}` : `连接失败：${res.error ?? "未知错误"}`,
      res.ok ? "ok" : "err"
    );
  } catch (err) {
    setStatus(`连接失败：${err instanceof Error ? err.message : String(err)}`, "err");
  } finally {
    btn.disabled = false;
  }
});

$("p-save").addEventListener("click", async () => {
  const current = await getSettings();
  await saveSettings({ ...current, api: await readApi() });
  setStatus("已保存 ✔", "ok");
});

$("p-full-settings").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ===== 当前网站加入白名单 / 黑名单 =====
let currentHost = "";

async function initSite(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url;
    if (!url) return;
    currentHost = new URL(url).hostname.replace(/^www\./, "");
    const el = $("site-name");
    el.textContent = currentHost || "未知站点";
  } catch {
    /* 忽略 */
  }
}

async function addSite(list: "whitelist" | "blacklist"): Promise<void> {
  if (!currentHost) {
    setStatus("无法获取当前站点", "err");
    return;
  }
  const s = await getSettings();
  const arr = s.sites[list];
  if (!arr.includes(currentHost)) arr.push(currentHost);
  await saveSettings(s);
  setStatus(list === "whitelist" ? `已加入白名单 ✔ ${currentHost}` : `已加入黑名单 ✔ ${currentHost}`, "ok");
}

$("btn-whitelist").addEventListener("click", () => void addSite("whitelist"));
$("btn-blacklist").addEventListener("click", () => void addSite("blacklist"));
void initSite();

void loadForm();
