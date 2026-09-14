/** 弹窗：快捷 API 配置（免进设置页）+ 测试连接 + 保存 */
import type {
  TestConnectionRequestMessage,
  TestConnectionResponseMessage,
} from "../shared/messages";
import { getSettings, saveSettings } from "../shared/storage";
import type { ApiConfig, ApiFormat } from "../shared/types";
import { t } from "../shared/i18n";

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

/** 免费通道无需连接参数 */
const FREE_FORMATS = new Set(["googlefree", "microsoft"]);

function syncFreeFields(): void {
  const isFree = FREE_FORMATS.has(($("p-format") as HTMLSelectElement).value);
  for (const id of ["p-base-url", "p-api-key", "p-model"]) {
    const el = $(id) as HTMLInputElement;
    el.disabled = isFree;
    // 不清空原值：用户临时切换免费通道后切回第三方 API，原有 Key/地址应保留
  }
}

async function readApi(): Promise<ApiConfig> {
  const current = await getSettings();
  const format = ($("p-format") as HTMLSelectElement).value as ApiFormat;
  // 始终读取输入框当前值：切到免费通道时输入框仅禁用不清空，保存不会抹掉原有第三方配置。
  // googlefree provider 会忽略 baseUrl/apiKey/model，无需在这里强行置空。
  return {
    ...current.api, // 保留温度/超时/并发等已配置值
    format,
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
  syncFreeFields();
}

($("version")).textContent = `v${chrome.runtime.getManifest().version}`;

$("p-test").addEventListener("click", async () => {
  const api = await readApi();
  if (!FREE_FORMATS.has(api.format) && (!api.baseUrl || !api.model)) {
    setStatus(t("popupNeedBaseUrl"), "err");
    return;
  }
  const btn = $("p-test") as HTMLButtonElement;
  btn.disabled = true;
  setStatus(t("popupTestRunning"));
  try {
    const req: TestConnectionRequestMessage = { type: "test-connection", id: crypto.randomUUID(), api };
    const res = (await chrome.runtime.sendMessage(req)) as TestConnectionResponseMessage;
    setStatus(
      res.ok
        ? t("popupTestOk", res.message ?? "")
        : t("popupTestFail", res.error ?? t("popupUnknownError")),
      res.ok ? "ok" : "err"
    );
  } catch (err) {
    setStatus(t("popupTestFail", err instanceof Error ? err.message : String(err)), "err");
  } finally {
    btn.disabled = false;
  }
});

$("p-save").addEventListener("click", async () => {
  const current = await getSettings();
  await saveSettings({ ...current, api: await readApi() });
  setStatus(t("popupSaved"), "ok");
});

$("p-full-settings").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$("p-format").addEventListener("change", syncFreeFields);

// ===== 当前网站加入白名单 / 黑名单 =====
let currentHost = "";

async function initSite(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url;
    if (!url) return;
    currentHost = new URL(url).hostname.replace(/^www\./, "");
    const el = $("site-name");
    el.textContent = currentHost || t("popupUnknownSite");
  } catch {
    /* 忽略 */
  }
}

async function addSite(list: "whitelist" | "blacklist"): Promise<void> {
  if (!currentHost) {
    setStatus(t("popupNoSite"), "err");
    return;
  }
  const s = await getSettings();
  const arr = s.sites[list];
  if (!arr.includes(currentHost)) arr.push(currentHost);
  // 从对立名单移除，避免同时在两个名单里产生冲突（黑名单优先会让白名单条目失效且迷惑用户）
  const other = list === "whitelist" ? "blacklist" : "whitelist";
  const otherIdx = s.sites[other].indexOf(currentHost);
  if (otherIdx >= 0) s.sites[other].splice(otherIdx, 1);
  await saveSettings(s);
  setStatus(
    list === "whitelist" ? t("popupWhitelisted", currentHost) : t("popupBlacklisted", currentHost),
    "ok"
  );
}

$("btn-whitelist").addEventListener("click", () => void addSite("whitelist"));
$("btn-blacklist").addEventListener("click", () => void addSite("blacklist"));
void initSite();

void loadForm();
