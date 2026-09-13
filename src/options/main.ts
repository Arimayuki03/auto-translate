import type {
  CacheStatsResponseMessage,
  CleanupCacheResponseMessage,
  ClearCacheMessage,
  TestConnectionRequestMessage,
  TestConnectionResponseMessage,
} from "../shared/messages";
import { exportSettings, getSettings, importSettings, saveSettings } from "../shared/storage";
import type { ApiConfig, ApiFormat, BatchMode, Settings, TranslationStyle } from "../shared/types";

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
  googlefree: {
    url: "（无需填写）",
    model: "（无需填写）",
    hint: "Google 免费通道：无需 BaseURL / Key / 模型，开箱即用。免费但有频率限制，适合无 Key 或备用兜底。",
  },
  microsoft: {
    url: "（无需填写）",
    model: "（无需填写）",
    hint: "Microsoft 免费通道：无需 BaseURL / Key / 模型，端点原生支持批量。与 Google 免费通道互为备份——一方被限流时自动切到另一方（未配置备用 API 时）。",
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
  const isFree = fmt === "googlefree" || fmt === "microsoft";
  const isGoogleFree = fmt === "googlefree";
  const baseUrl = $("base-url") as HTMLInputElement;
  const model = $("model") as HTMLInputElement;
  const apiKey = $("api-key") as HTMLInputElement;
  const batchMode = $("batch-mode") as HTMLSelectElement;
  // 免费通道无需连接参数：禁用但不清空——切回第三方 API 时原有 Key/地址/模型要能直接用
  baseUrl.disabled = isFree;
  model.disabled = isFree;
  apiKey.disabled = isFree;
  if (!isFree) {
    if (!baseUrl.value) baseUrl.placeholder = info.url;
    if (!model.value) model.placeholder = info.model;
  }
  // 免费通道内部固定安全哨兵协议，批量协议选项不适用；自定义端点仅 Google 免费通道支持
  batchMode.disabled = isFree;
  $("free-endpoint-row").style.display = isGoogleFree ? "" : "none";
  $("free-backup-endpoint-row").style.display = isGoogleFree ? "" : "none";
}

async function loadForm(): Promise<void> {
  const s = await getSettings();
  const api = s.api;
  select("api-format").value = api.format;
  input("base-url").value = api.baseUrl;
  input("api-key").value = api.apiKey;
  input("model").value = api.model;
  select("batch-mode").value = api.batchMode ?? "lines";
  ($("custom-prompt") as HTMLTextAreaElement).value = api.customSystemPrompt ?? "";
  input("free-endpoint").value = api.freeEndpoint ?? "";
  input("free-backup-endpoint").value = api.freeBackupEndpoint ?? "";
  input("temperature").value = String(api.temperature);
  input("timeout").value = String(Math.round(api.timeoutMs / 1000));
  input("concurrency").value = String(api.maxConcurrency);
  input("request-interval").value = String(api.minRequestIntervalMs ?? 500);
  if (s.backupApi) {
    select("backup-format").value = s.backupApi.format;
    input("backup-base-url").value = s.backupApi.baseUrl;
    input("backup-api-key").value = s.backupApi.apiKey;
    input("backup-model").value = s.backupApi.model;
  }
  ($("auto-translate") as HTMLInputElement).checked = s.translate.autoTranslate;
  ($("viewport-lazy") as HTMLInputElement).checked = s.translate.viewportLazy;
  ($("translate-on-select") as HTMLInputElement).checked = s.translate.translateOnSelect;
  ($("translate-input") as HTMLInputElement).checked = s.translate.translateInput;
  ($("context-enabled") as HTMLInputElement).checked = s.translate.contextEnabled ?? true;
  input("context-max-chars").value = String(s.translate.contextMaxChars ?? 3000);
  select("style-theme").value = s.translate.style ?? "gray";
  ($("custom-css") as HTMLTextAreaElement).value = s.translate.customCss ?? "";
  ($("translate-attributes") as HTMLInputElement).checked = s.translate.translateAttributes ?? true;
  ($("tts-enabled") as HTMLInputElement).checked = s.tts.enabled;
  select("tts-voice").value = s.tts.voice;
  select("tts-rate").value = String(s.tts.rate);
  ($("sensitive-pages") as HTMLInputElement).checked = s.security.sensitivePages;
  ($("whitelist") as HTMLTextAreaElement).value = s.sites.whitelist.join("\n");
  ($("blacklist") as HTMLTextAreaElement).value = s.sites.blacklist.join("\n");
  input("cache-ttl-days").value = String(s.cache.ttlDays ?? 7);
  updateFormatHint();
  void refreshCacheStats();
}

/** 设置页「缓存管理」：展示磁盘层条目数（缓存前缀计数，不读值内容） */
async function refreshCacheStats(): Promise<void> {
  const el = $("cache-stats");
  try {
    const res = (await chrome.runtime.sendMessage({ type: "cache-stats" })) as CacheStatsResponseMessage;
    el.textContent = res?.error ? `统计失败：${res.error}` : `${res?.count ?? 0} 条`;
  } catch (err) {
    el.textContent = `统计失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

async function readForm(): Promise<Settings> {
  const current = await getSettings();
  // temperature 允许为 0（parseFloat 结果 NaN 才回退默认值，0 是合法值不能被 || 吞掉）
  const tempParsed = parseFloat(($("temperature") as HTMLInputElement).value);
  const api: ApiConfig = {
    format: select("api-format").value as ApiFormat,
    baseUrl: ($("base-url") as HTMLInputElement).value.trim(),
    apiKey: ($("api-key") as HTMLInputElement).value.trim(),
    model: ($("model") as HTMLInputElement).value.trim(),
    temperature: Number.isNaN(tempParsed) ? 0.3 : tempParsed,
    timeoutMs: (parseInt(($("timeout") as HTMLInputElement).value, 10) || 60) * 1000,
    // 兜底与默认值一致（2），并钳制 ≥1
    maxConcurrency: Math.max(1, parseInt(($("concurrency") as HTMLInputElement).value, 10) || 2),
    // 请求启动间隔：默认 500ms，钳制 50–10000，适配限流严格的中转站可调大
    minRequestIntervalMs: Math.min(
      10000,
      Math.max(50, parseInt(($("request-interval") as HTMLInputElement).value, 10) || 500)
    ),
    batchMode: select("batch-mode").value as BatchMode,
    // 自定义附加指令：拼在系统提示词最前（批量协议段保留在其后），限长防提示词膨胀
    customSystemPrompt: ($("custom-prompt") as HTMLTextAreaElement).value.slice(0, 2000),
    // 免费端点仅 googlefree 使用：非免费通道保留原值，避免误清
    freeEndpoint: (select("api-format").value as ApiFormat) === "googlefree"
      ? ($("free-endpoint") as HTMLInputElement).value.trim()
      : current.api.freeEndpoint,
    freeBackupEndpoint: (select("api-format").value as ApiFormat) === "googlefree"
      ? ($("free-backup-endpoint") as HTMLInputElement).value.trim()
      : current.api.freeBackupEndpoint,
  };
  const backupBaseUrl = ($("backup-base-url") as HTMLInputElement).value.trim();
  const backupModel = ($("backup-model") as HTMLInputElement).value.trim();
  const backupFormat = select("backup-format").value as ApiFormat;
  const backupFree = backupFormat === "googlefree";
  const backupApi: ApiConfig | undefined =
    (backupFree || (backupBaseUrl && backupModel))
      ? {
          format: backupFormat,
          baseUrl: backupFree ? "" : backupBaseUrl,
          apiKey: backupFree ? "" : ($("backup-api-key") as HTMLInputElement).value.trim(),
          model: backupFree ? "" : backupModel,
          temperature: api.temperature,
          timeoutMs: api.timeoutMs,
          maxConcurrency: api.maxConcurrency,
          batchMode: api.batchMode,
          freeEndpoint: current.backupApi?.freeEndpoint ?? api.freeEndpoint,
          freeBackupEndpoint: current.backupApi?.freeBackupEndpoint ?? api.freeBackupEndpoint,
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
      translateOnSelect: ($("translate-on-select") as HTMLInputElement).checked,
      translateInput: ($("translate-input") as HTMLInputElement).checked,
      contextEnabled: ($("context-enabled") as HTMLInputElement).checked,
      contextMaxChars: Math.max(
        0,
        parseInt(($("context-max-chars") as HTMLInputElement).value, 10) || 3000
      ),
      style: select("style-theme").value as TranslationStyle,
      customCss: ($("custom-css") as HTMLTextAreaElement).value.slice(0, 8000),
      translateAttributes: ($("translate-attributes") as HTMLInputElement).checked,
    },
    sites: {
      whitelist: parseDomainList($("whitelist") as HTMLTextAreaElement),
      blacklist: parseDomainList($("blacklist") as HTMLTextAreaElement),
    },
    tts: {
      ...current.tts,
      enabled: ($("tts-enabled") as HTMLInputElement).checked,
      voice: select("tts-voice").value,
      rate: parseInt(select("tts-rate").value, 10) || 0,
    },
    security: {
      ...current.security,
      sensitivePages: ($("sensitive-pages") as HTMLInputElement).checked,
    },
    cache: {
      ...current.cache,
      // 0 = 永不过期是合法值，不能用 || 兜底吞掉
      ttlDays: (() => {
        const parsed = parseInt(($("cache-ttl-days") as HTMLInputElement).value, 10);
        return Number.isNaN(parsed) ? (current.cache.ttlDays ?? 7) : Math.min(365, Math.max(0, parsed));
      })(),
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

function updateBackupFormatFields(): void {
  const isFree = select("backup-format").value === "googlefree" || select("backup-format").value === "microsoft";
  for (const id of ["backup-base-url", "backup-api-key", "backup-model"]) {
    const el = $(id) as HTMLInputElement;
    el.disabled = isFree;
    // 不清空原值：临时切换免费通道后切回第三方 API 时保留原有配置
  }
}

/** 通用测试连接：主 / 备用 API 复用，失败信息带来源前缀便于区分是哪一路出错 */
async function runTestConnection(api: ApiConfig | undefined, btnId: string, label: string): Promise<void> {
  if (!api) {
    setStatus(`未配置${label}，跳过`, "err");
    return;
  }
  if (api.format !== "googlefree" && api.format !== "microsoft" && (!api.baseUrl || !api.model)) {
    setStatus(`${label}请先填写 BaseURL 和模型`, "err");
    return;
  }
  const btn = $(btnId) as HTMLButtonElement;
  btn.disabled = true;
  setStatus(`测试${label}中…`);
  try {
    const req: TestConnectionRequestMessage = { type: "test-connection", id: crypto.randomUUID(), api };
    const res = (await chrome.runtime.sendMessage(req)) as TestConnectionResponseMessage;
    setStatus(
      res.ok
        ? `${label}连接成功：${res.message ?? ""}`
        : `${label}连接失败：${res.error ?? "未知错误"}`,
      res.ok ? "ok" : "err"
    );
  } catch (err) {
    setStatus(`${label}连接失败：${err instanceof Error ? err.message : String(err)}`, "err");
  } finally {
    btn.disabled = false;
  }
}

function init(): void {
  $("api-format").addEventListener("change", updateFormatHint);
  $("backup-format").addEventListener("change", updateBackupFormatFields);
  $("btn-save").addEventListener("click", async () => {
    const s = await readForm();
    await saveSettings(s);
    setStatus("已保存 ✔", "ok");
  });
  $("btn-test").addEventListener("click", async () => {
    const s = await readForm();
    await runTestConnection(s.api, "btn-test", "主 API");
  });
  $("btn-test-backup").addEventListener("click", async () => {
    const s = await readForm();
    if (!s.backupApi) {
      setStatus("未配置备用 API（填写备用 BaseURL 和模型，或选择 Google 免费通道）", "err");
      return;
    }
    await runTestConnection(s.backupApi, "btn-test-backup", "备用 API");
  });
  $("btn-clear-cache").addEventListener("click", async () => {
    const res = (await chrome.runtime.sendMessage({ type: "clear-cache" } as ClearCacheMessage)) as {
      ok?: boolean;
      error?: string;
    };
    setStatus(res?.ok ? "缓存已清空 ✔" : `清空失败：${res?.error ?? "未知错误"}`, res?.ok ? "ok" : "err");
    void refreshCacheStats();
  });

  $("btn-cleanup-cache").addEventListener("click", async () => {
    const res = (await chrome.runtime.sendMessage({ type: "cleanup-cache" })) as CleanupCacheResponseMessage;
    setStatus(
      res?.ok ? `清理完成 ✔ 移除 ${res.removed ?? 0} 条过期/超额条目` : `清理失败：${res?.error ?? "未知错误"}`,
      res?.ok ? "ok" : "err"
    );
    void refreshCacheStats();
  });

  $("btn-export").addEventListener("click", async () => {
    // 走统一的导出入口：API Key 保持加密态落盘，避免明文泄进导出文件
    const stored = await exportSettings();
    const blob = new Blob([JSON.stringify(stored, null, 2)], {
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
      // 统一导入入口：校验 provider 格式、兼容 { settings: ... } 包装、导入后立即迁移
      await importSettings(parsed);
      await loadForm(); // 刷新表单，否则接着点「保存」会用旧表单值覆盖刚导入的设置
      setStatus("设置已导入 ✔（建议重新测试连接）", "ok");
    } catch (err) {
      setStatus(`导入失败：${err instanceof Error ? err.message : String(err)}`, "err");
    }
  });

  void loadForm();
}

init();