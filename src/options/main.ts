import type {
  ClearCacheMessage,
  TestConnectionRequestMessage,
  TestConnectionResponseMessage,
} from "../shared/messages";
import { getSettings, saveSettings } from "../shared/storage";
import type { ApiConfig, ApiFormat, Settings } from "../shared/types";

const FORMAT_INFO: Record<ApiFormat, { url: string; model: string; hint: string }> = {
  openai: {
    url: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    hint: "OpenAI 兼容：DeepSeek / OneAPI / new-api / vLLM / 各类中转",
  },
  anthropic: {
    url: "https://api.anthropic.com",
    model: "claude-sonnet-4-20250514",
    hint: "Claude：插件自动拼接 /v1/messages",
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com",
    model: "gemini-2.0-flash",
    hint: "Gemini：插件自动拼接 /v1beta/models/{model}:generateContent",
  },
  ollama: {
    url: "http://127.0.0.1:11434",
    model: "qwen2.5",
    hint: "Ollama 原生：插件自动拼接 /api/chat",
  },
};

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`元素不存在: ${id}`);
  return el as T;
}

/** 表单控件快捷取值（input / select / textarea） */
const input = (id: string): HTMLInputElement => $(id);
const select = (id: string): HTMLSelectElement => $(id);

function setStatus(text: string, kind: "ok" | "err" | "" = ""): void {
  const el = $("status");
  el.textContent = text;
  el.className = `status ${kind}`.trim();
}

function updateFormatHint(): void {
  const fmt = select("api-format").value as ApiFormat;
  const info = FORMAT_INFO[fmt];
  $("format-hint").textContent = info.hint;
  const baseUrl = $("base-url") as HTMLInputElement;
  const model = $("model") as HTMLInputElement;
  if (!baseUrl.value) baseUrl.placeholder = info.url;
  if (!model.value) model.placeholder = info.model;
}

async function loadForm(): Promise<void> {
  const s = await getSettings();
  const api = s.api;
  select("api-format").value = api.format;
  input("base-url").value = api.baseUrl;
  input("api-key").value = api.apiKey;
  input("model").value = api.model;
  input("temperature").value = String(api.temperature);
  input("timeout").value = String(Math.round(api.timeoutMs / 1000));
  input("concurrency").value = String(api.maxConcurrency);
  if (s.backupApi) {
    select("backup-format").value = s.backupApi.format;
    input("backup-base-url").value = s.backupApi.baseUrl;
    input("backup-api-key").value = s.backupApi.apiKey;
    input("backup-model").value = s.backupApi.model;
  }
  ($("auto-translate") as HTMLInputElement).checked = s.translate.autoTranslate;
  ($("viewport-lazy") as HTMLInputElement).checked = s.translate.viewportLazy;
  ($("whitelist") as HTMLTextAreaElement).value = s.sites.whitelist.join("\n");
  ($("blacklist") as HTMLTextAreaElement).value = s.sites.blacklist.join("\n");
  updateFormatHint();
}

async function readForm(): Promise<Settings> {
  const current = await getSettings();
  const api: ApiConfig = {
    format: select("api-format").value as ApiFormat,
    baseUrl: ($("base-url") as HTMLInputElement).value.trim(),
    apiKey: ($("api-key") as HTMLInputElement).value.trim(),
    model: ($("model") as HTMLInputElement).value.trim(),
    temperature: parseFloat(($("temperature") as HTMLInputElement).value) || 0.3,
    timeoutMs: (parseInt(($("timeout") as HTMLInputElement).value, 10) || 60) * 1000,
    maxConcurrency: parseInt(($("concurrency") as HTMLInputElement).value, 10) || 3,
  };
  const backupBaseUrl = ($("backup-base-url") as HTMLInputElement).value.trim();
  const backupModel = ($("backup-model") as HTMLInputElement).value.trim();
  const backupApi: ApiConfig | undefined =
    backupBaseUrl && backupModel
      ? {
          format: select("backup-format").value as ApiFormat,
          baseUrl: backupBaseUrl,
          apiKey: ($("backup-api-key") as HTMLInputElement).value.trim(),
          model: backupModel,
          temperature: api.temperature,
          timeoutMs: api.timeoutMs,
          maxConcurrency: api.maxConcurrency,
        }
      : undefined;
  return {
    ...current,
    api,
    backupApi,
    translate: {
      ...current.translate,
      autoTranslate: ($("auto-translate") as HTMLInputElement).checked,
      viewportLazy: ($("viewport-lazy") as HTMLInputElement).checked,
    },
    sites: {
      whitelist: parseDomainList($("whitelist") as HTMLTextAreaElement),
      blacklist: parseDomainList($("blacklist") as HTMLTextAreaElement),
    },
  };
}

/** 解析每行一个域名的文本域：规范化为主域名（去协议/www/路径/端口，小写） */
function parseDomainList(el: HTMLTextAreaElement): string[] {
  return el.value
    .split(/\n|,/)
    .map((s) =>
      s
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/[/:].*$/, "")
    )
    .filter(Boolean);
}

function init(): void {
  $("api-format").addEventListener("change", updateFormatHint);
  $("btn-save").addEventListener("click", async () => {
    const s = await readForm();
    await saveSettings(s);
    setStatus("已保存 ✔", "ok");
  });
  $("btn-test").addEventListener("click", async () => {
    const s = await readForm();
    if (!s.api.baseUrl || !s.api.model) {
      setStatus("请先填写 BaseURL 和模型", "err");
      return;
    }
    const btn = $("btn-test") as HTMLButtonElement;
    btn.disabled = true;
    setStatus("测试中…");
    try {
      const req: TestConnectionRequestMessage = {
        type: "test-connection",
        id: crypto.randomUUID(),
        api: s.api,
      };
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
  $("btn-clear-cache").addEventListener("click", async () => {
    const res = (await chrome.runtime.sendMessage({ type: "clear-cache" } as ClearCacheMessage)) as {
      ok?: boolean;
      error?: string;
    };
    setStatus(res?.ok ? "缓存已清空 ✔" : `清空失败：${res?.error ?? "未知错误"}`, res?.ok ? "ok" : "err");
  });

  $("btn-export").addEventListener("click", async () => {
    const stored = await chrome.storage.local.get("settings");
    const blob = new Blob([JSON.stringify(stored.settings ?? {}, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `auto-translate-settings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus("设置已导出 ✔", "ok");
  });

  $("btn-import").addEventListener("click", () => ($("import-file") as HTMLInputElement).click());

  $("import-file").addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!parsed || typeof parsed !== "object") throw new Error("不是有效的设置文件");
      await chrome.storage.local.set({ settings: parsed });
      setStatus("设置已导入 ✔（建议重新测试连接）", "ok");
    } catch (err) {
      setStatus(`导入失败：${err instanceof Error ? err.message : String(err)}`, "err");
    }
  });

  void loadForm();
}

init();