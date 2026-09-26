import type {
  CacheStatsResponseMessage,
  CleanupCacheResponseMessage,
  ClearCacheMessage,
  TestConnectionRequestMessage,
  TestConnectionResponseMessage,
} from "../shared/messages";
import { BUILT_IN_RULES, sanitizeSiteRules } from "../shared/siteRules";
import type { SiteRule } from "../shared/siteRules";
import { exportSettings, getSettings, importSettings, saveSettings, SETTING_RANGES } from "../shared/storage";
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

/** loadForm 时刻站点面板各文本域的初始值：供 readForm 判定「用户本会话是否编辑过」。
 *  保存是全表单提交——若 textarea 仍停留在页面打开时的快照，popup 期间对站点名单的
 *  增删（如「加入白名单」）会被陈旧表单整体落盘回滚；此处段级合并挡住该竞态。 */
const initialSiteInputs: {
  whitelist: string | null;
  blacklist: string | null;
  siteRules: string | null;
} = { whitelist: null, blacklist: null, siteRules: null };

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
  // 免费通道隐藏连接字段并给出说明行；googlefree 额外露出自定义端点配置
  for (const row of ["base-url-row", "api-key-row", "model-row", "batch-mode-row"]) {
    $(row).hidden = isFree;
  }
  $("free-endpoint-row").hidden = !isGoogleFree;
  $("free-backup-endpoint-row").hidden = !isGoogleFree;
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
  ($("translate-hover") as HTMLInputElement).checked = s.translate.translateHover ?? false;
  ($("context-enabled") as HTMLInputElement).checked = s.translate.contextEnabled ?? true;
  input("context-max-chars").value = String(s.translate.contextMaxChars ?? 3000);
  ($("summary-enabled") as HTMLInputElement).checked = s.translate.summaryEnabled ?? false;
  input("summary-min-chars").value = String(s.translate.summaryMinChars ?? 6000);
  const styleValue = s.translate.style ?? "gray";
  for (const radio of document.querySelectorAll<HTMLInputElement>("input[name='style-theme']")) {
    radio.checked = radio.value === styleValue;
  }
  ($("custom-css") as HTMLTextAreaElement).value = s.translate.customCss ?? "";
  ($("translate-attributes") as HTMLInputElement).checked = s.translate.translateAttributes ?? true;
  select("force-source-lang").value = s.translate.forceSourceLang ?? "";
  ($("tts-enabled") as HTMLInputElement).checked = s.tts.enabled;
  select("tts-voice").value = s.tts.voice;
  select("tts-rate").value = String(s.tts.rate);
  ($("sensitive-pages") as HTMLInputElement).checked = s.security.sensitivePages;
  ($("whitelist") as HTMLTextAreaElement).value = s.sites.whitelist.join("\n");
  ($("blacklist") as HTMLTextAreaElement).value = s.sites.blacklist.join("\n");
  renderBuiltinRules(s.sites.disabledRuleIds ?? []);
  ($("site-rules") as HTMLTextAreaElement).value = (s.sites.rules ?? [])
    .map((r) => JSON.stringify(r))
    .join("\n");
  // 记录初始快照：readForm 据此区分「未编辑（沿用存储现值）」与「已编辑（解析表单值）」
  snapshotSiteInputs();
  input("cache-ttl-days").value = String(s.cache.ttlDays ?? 7);
  updateFormatHint();
  void refreshCacheStats();
}

/** 刷新站点文本域快照：loadForm 与保存成功后调用。
 *  保存后刷新使连续两次保存之间 popup 的名单写入不会被上一轮编辑态误判覆盖。 */
function snapshotSiteInputs(): void {
  initialSiteInputs.whitelist = ($("whitelist") as HTMLTextAreaElement).value;
  initialSiteInputs.blacklist = ($("blacklist") as HTMLTextAreaElement).value;
  initialSiteInputs.siteRules = ($("site-rules") as HTMLTextAreaElement).value;
}

/** 内置站点规则勾选列表：勾选 = 启用，取消 = 禁用（落 disabledRuleIds） */
function renderBuiltinRules(disabled: string[]): void {
  const box = $("builtin-rules");
  box.innerHTML = "";
  const disabledSet = new Set(disabled);
  for (const rule of BUILT_IN_RULES) {
    if (!rule.id) continue;
    const item = document.createElement("label");
    item.className = "rule-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.ruleId = rule.id;
    cb.checked = !disabledSet.has(rule.id);
    const span = document.createElement("span");
    span.textContent = `${rule.name ?? rule.id}（${rule.matches.join("、")}）`;
    item.append(cb, span);
    box.appendChild(item);
  }
}

/**
 * 解析自定义规则文本域：每行一条 JSON 对象（// 开头的注释行跳过），也兼容整段 JSON 数组。
 * 解析结果再过一遍 sanitizeSiteRules 与导入路径同口径。格式错误抛错给保存流程提示行号。
 */
function parseSiteRulesTextarea(text: string): SiteRule[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let raw: unknown;
  if (trimmed.startsWith("[")) {
    raw = JSON.parse(trimmed);
  } else {
    const arr: unknown[] = [];
    for (const [i, line] of trimmed.split("\n").entries()) {
      const l = line.trim();
      if (!l || l.startsWith("//")) continue;
      try {
        arr.push(JSON.parse(l));
      } catch {
        throw new Error(`站点规则第 ${i + 1} 行不是有效的 JSON`);
      }
    }
    raw = arr;
  }
  const rules = sanitizeSiteRules(raw);
  if (rules === undefined) throw new Error("站点规则格式无效（应为 JSON 数组或每行一个对象）");
  return rules;
}

/** 设置页「缓存管理」：展示磁盘层条目数（缓存前缀计数，不读值内容） */
async function refreshCacheStats(): Promise<void> {
  const el = $("cache-stats");
  try {
    const res = (await chrome.runtime.sendMessage({
      type: "cache-stats",
    })) as CacheStatsResponseMessage;
    el.textContent = res?.error ? `统计失败：${res.error}` : `${res?.count ?? 0} 条`;
  } catch (err) {
    el.textContent = `统计失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

/** 表单数值解析：parseInt 失败/NaN 回退 fallback，结果钳制到该字段的合法区间。
 *  区间来自 storage 的 SETTING_RANGES（与导入校验同一份），防止 UI 与导入两套规则。 */
function rangedInt(input: HTMLInputElement, fallback: number, range: readonly [number, number]) {
  const parsed = parseInt(input.value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(range[1], Math.max(range[0], parsed));
}

/** 从表单构建主 API 配置段：readForm（保存）与测试连接路径共用，避免两处漂移 */
function buildApiForm(current: Settings): ApiConfig {
  // temperature 允许为 0（parseFloat 结果 NaN 才回退默认值，0 是合法值不能被 || 吞掉）
  const tempParsed = parseFloat(($("temperature") as HTMLInputElement).value);
  const tempRange = SETTING_RANGES.temperature;
  return {
    format: select("api-format").value as ApiFormat,
    baseUrl: ($("base-url") as HTMLInputElement).value.trim(),
    apiKey: ($("api-key") as HTMLInputElement).value.trim(),
    model: ($("model") as HTMLInputElement).value.trim(),
    temperature: Number.isNaN(tempParsed)
      ? 0.3
      : Math.min(tempRange[1], Math.max(tempRange[0], tempParsed)),
    timeoutMs: rangedInt($("timeout") as HTMLInputElement, 60, SETTING_RANGES.timeoutSeconds) * 1000,
    maxConcurrency: rangedInt(
      $("concurrency") as HTMLInputElement,
      2,
      SETTING_RANGES.maxConcurrency
    ),
    minRequestIntervalMs: rangedInt(
      $("request-interval") as HTMLInputElement,
      500,
      SETTING_RANGES.minRequestIntervalMs
    ),
    batchMode: select("batch-mode").value as BatchMode,
    // 自定义附加指令：拼在系统提示词最前（批量协议段保留在其后），限长防提示词膨胀
    customSystemPrompt: ($("custom-prompt") as HTMLTextAreaElement).value.slice(0, 2000),
    // 免费端点仅 googlefree 使用：非免费通道保留原值，避免误清
    freeEndpoint:
      (select("api-format").value as ApiFormat) === "googlefree"
        ? ($("free-endpoint") as HTMLInputElement).value.trim()
        : current.api.freeEndpoint,
    freeBackupEndpoint:
      (select("api-format").value as ApiFormat) === "googlefree"
        ? ($("free-backup-endpoint") as HTMLInputElement).value.trim()
        : current.api.freeBackupEndpoint,
  };
}

/** 从表单构建备用 API 配置段：readForm（保存）与测试连接路径共用 */
function buildBackupApiForm(current: Settings, api: ApiConfig): ApiConfig | undefined {
  const backupBaseUrl = ($("backup-base-url") as HTMLInputElement).value.trim();
  const backupModel = ($("backup-model") as HTMLInputElement).value.trim();
  const backupFormat = select("backup-format").value as ApiFormat;
  // 两种免费通道（googlefree / microsoft）都无需 BaseURL/Key/模型。只认 googlefree
  // 会把选微软免费通道的备用配置判成「未配置」（空 baseUrl+空 model 过不了存在性检查）
  const backupFree = backupFormat === "googlefree" || backupFormat === "microsoft";
  return backupFree || (backupBaseUrl && backupModel)
    ? {
        format: backupFormat,
        // 免费通道不主动清空连接字段：与主通道「禁用但保留」语义一致（updateFormatHint /
        // popup syncFreeFields 同款），临时切免费再切回第三方 API 时原配置仍在。
        // googlefree/microsoft provider 本就忽略 baseUrl/apiKey/model，落盘无害
        baseUrl: backupBaseUrl,
        apiKey: ($("backup-api-key") as HTMLInputElement).value.trim(),
        model: backupModel,
        temperature: api.temperature,
        timeoutMs: api.timeoutMs,
        maxConcurrency: api.maxConcurrency,
        batchMode: api.batchMode,
        freeEndpoint: current.backupApi?.freeEndpoint ?? api.freeEndpoint,
        freeBackupEndpoint: current.backupApi?.freeBackupEndpoint ?? api.freeBackupEndpoint,
      }
    : undefined;
}

/** 测试连接专用：只读 API 表单段（主/备用），不解析站点规则等无关段。
 *  用户测的是连通性——站点面板的 JSON 笔误不应阻断测试，更不该被报成「测试失败」。 */
async function readApiForm(): Promise<{ api: ApiConfig; backupApi: ApiConfig | undefined }> {
  const current = await getSettings();
  const api = buildApiForm(current);
  return { api, backupApi: buildBackupApiForm(current, api) };
}

async function readForm(): Promise<Settings> {
  const current = await getSettings();
  const api = buildApiForm(current);
  const backupApi = buildBackupApiForm(current, api);
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
      translateHover: ($("translate-hover") as HTMLInputElement).checked,
      contextEnabled: ($("context-enabled") as HTMLInputElement).checked,
      contextMaxChars: rangedInt(
        $("context-max-chars") as HTMLInputElement,
        3000,
        SETTING_RANGES.contextMaxChars
      ),
      summaryEnabled: ($("summary-enabled") as HTMLInputElement).checked,
      // 显式 0（=长短页都生成）是合法值，不能被 || 吞掉；rangedInt 的 NaN 分支保证这一点
      summaryMinChars: rangedInt(
        $("summary-min-chars") as HTMLInputElement,
        6000,
        SETTING_RANGES.summaryMinChars
      ),
      style: (document.querySelector<HTMLInputElement>("input[name='style-theme']:checked")
        ?.value ?? "gray") as TranslationStyle,
      customCss: ($("custom-css") as HTMLTextAreaElement).value.slice(0, 8000),
      translateAttributes: ($("translate-attributes") as HTMLInputElement).checked,
      forceSourceLang: select("force-source-lang").value,
    },
    // ===== sites 段级合并：只在用户本会话真正编辑过对应文本域时才用表单值落盘 =====
    // 未编辑的字段沿用 getSettings() 现值，避免陈旧快照覆盖 popup 期间的名单增删
    //（如页面开着时 popup「加入白名单」被旧 textarea 回滚）。导入等外部变更后的
    // loadForm 会刷新快照，编辑判定始终对准本次快照。
    sites: {
      whitelist:
        ($("whitelist") as HTMLTextAreaElement).value === initialSiteInputs.whitelist
          ? current.sites.whitelist
          : parseDomainList($("whitelist") as HTMLTextAreaElement),
      blacklist:
        ($("blacklist") as HTMLTextAreaElement).value === initialSiteInputs.blacklist
          ? current.sites.blacklist
          : parseDomainList($("blacklist") as HTMLTextAreaElement),
      rules:
        ($("site-rules") as HTMLTextAreaElement).value === initialSiteInputs.siteRules
          ? current.sites.rules ?? []
          : parseSiteRulesTextarea(($("site-rules") as HTMLTextAreaElement).value),
      disabledRuleIds: Array.from(
        document.querySelectorAll<HTMLInputElement>("#builtin-rules input[type='checkbox']")
      )
        .filter((cb) => !cb.checked)
        .map((cb) => cb.dataset.ruleId ?? "")
        .filter(Boolean),
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
      ttlDays: rangedInt(
        $("cache-ttl-days") as HTMLInputElement,
        current.cache.ttlDays ?? 7,
        SETTING_RANGES.cacheTtlDays
      ),
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
  const isFree =
    select("backup-format").value === "googlefree" || select("backup-format").value === "microsoft";
  for (const id of ["backup-base-url", "backup-api-key", "backup-model"]) {
    const el = $(id) as HTMLInputElement;
    el.disabled = isFree;
    // 不清空原值：临时切换免费通道后切回第三方 API 时保留原有配置
  }
}

/** 通用测试连接：主 / 备用 API 复用，失败信息带来源前缀便于区分是哪一路出错 */
async function runTestConnection(
  api: ApiConfig | undefined,
  btnId: string,
  label: string
): Promise<void> {
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
    const req: TestConnectionRequestMessage = {
      type: "test-connection",
      id: crypto.randomUUID(),
      api,
    };
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

/** 侧边导航切换：显示目标面板，同步高亮；localStorage 记忆上次访问的分组 */
function switchPanel(name: string): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".nav-item")) {
    btn.classList.toggle("active", btn.dataset.panel === name);
  }
  for (const panel of document.querySelectorAll<HTMLElement>(".panel")) {
    panel.hidden = panel.dataset.panel !== name;
  }
  try {
    localStorage.setItem("options-panel", name);
  } catch {
    /* localStorage 不可用时忽略（隐私模式等） */
  }
  window.scrollTo({ top: 0 });
}

function init(): void {
  // 导航切换（含记忆：优先恢复上次访问的分组）
  let initialPanel = "";
  try {
    initialPanel = localStorage.getItem("options-panel") ?? "";
  } catch {
    /* 忽略 */
  }
  if (!document.querySelector(`.panel[data-panel='${CSS.escape(initialPanel)}']`)) {
    initialPanel = "api";
  }
  switchPanel(initialPanel);
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".nav-item")) {
    btn.addEventListener("click", () => switchPanel(btn.dataset.panel ?? "api"));
  }

  $("api-format").addEventListener("change", updateFormatHint);
  $("backup-format").addEventListener("change", updateBackupFormatFields);
  $("btn-save").addEventListener("click", async () => {
    try {
      const s = await readForm();
      await saveSettings(s);
      // 落盘值已成为新的「初始态」：刷新快照，让下一轮编辑判定对准刚保存的值
      snapshotSiteInputs();
      setStatus("已保存 ✔", "ok");
    } catch (err) {
      setStatus(`保存失败：${err instanceof Error ? err.message : String(err)}`, "err");
    }
  });
  $("btn-test").addEventListener("click", () => {
    const btn = $("btn-test") as HTMLButtonElement;
    // 同步先禁用再进入任何 await：readForm 有 storage 往返，晚禁用会留双击双发窗口
    btn.disabled = true;
    void (async () => {
      try {
        // 只读 API 段（readApiForm）：不解析站点规则——用户测的是连通性，
        // 站点面板的 JSON 笔误不应被报成「测试失败」、更不应阻断测试
        const { api } = await readApiForm();
        await runTestConnection(api, "btn-test", "主 API");
      } catch (err) {
        setStatus(`测试失败：${err instanceof Error ? err.message : String(err)}`, "err");
      } finally {
        btn.disabled = false;
      }
    })();
  });
  $("btn-test-backup").addEventListener("click", () => {
    const btn = $("btn-test-backup") as HTMLButtonElement;
    // 同步禁用：同 btn-test，防 readApiForm 往返窗口内的双击双发
    btn.disabled = true;
    void (async () => {
      try {
        const { backupApi } = await readApiForm();
        if (!backupApi) {
          setStatus(
            "未配置备用 API（填写备用 BaseURL 和模型，或选择 Google / Microsoft 免费通道）",
            "err"
          );
          return;
        }
        await runTestConnection(backupApi, "btn-test-backup", "备用 API");
      } catch (err) {
        setStatus(`测试失败：${err instanceof Error ? err.message : String(err)}`, "err");
      } finally {
        btn.disabled = false;
      }
    })();
  });
  $("btn-clear-cache").addEventListener("click", async () => {
    try {
      const res = (await chrome.runtime.sendMessage({
        type: "clear-cache",
      } as ClearCacheMessage)) as {
        ok?: boolean;
        error?: string;
      };
      setStatus(
        res?.ok ? "缓存已清空 ✔" : `清空失败：${res?.error ?? "未知错误"}`,
        res?.ok ? "ok" : "err"
      );
    } catch (err) {
      setStatus(`清空失败：${err instanceof Error ? err.message : String(err)}`, "err");
    }
    void refreshCacheStats();
  });

  $("btn-cleanup-cache").addEventListener("click", async () => {
    try {
      const res = (await chrome.runtime.sendMessage({
        type: "cleanup-cache",
      })) as CleanupCacheResponseMessage;
      setStatus(
        res?.ok
          ? `清理完成 ✔ 移除 ${res.removed ?? 0} 条过期/超额条目`
          : `清理失败：${res?.error ?? "未知错误"}`,
        res?.ok ? "ok" : "err"
      );
    } catch (err) {
      setStatus(`清理失败：${err instanceof Error ? err.message : String(err)}`, "err");
    }
    void refreshCacheStats();
  });

  $("btn-export").addEventListener("click", async () => {
    try {
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
    } catch (err) {
      setStatus(`导出失败：${err instanceof Error ? err.message : String(err)}`, "err");
    }
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
