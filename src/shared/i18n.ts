/**
 * UI 文案国际化（中英双语）：content / popup 注入 UI 的用户可见字符串统一收口在此。
 * 语言按浏览器 UI 语言自动选择（zh 开头 → 中文，否则英文）；默认中文与历史版本一致。
 * LLM 提示词 / background 内部错误文案不在此列（提示词属于协议，错误文案由 background 消费）。
 */

/** 文案值：纯文本或（带参数的）模板函数 */
export type I18nValue = string | ((...params: never[]) => string);

type Dict = Record<string, I18nValue>;

const zh: Dict = {
  // 通用
  translate: "译",
  restore: "还原",
  retry: "重试",
  close: "关闭",
  copy: "复制",
  copyFailed: "复制失败",
  // 划词气泡
  bubbleTitle: "译文",
  translating: "翻译中…",
  translateFailed: "翻译失败",
  translateSelection: "翻译选中内容",
  speak: "朗读",
  stop: "停止",
  speakGenerating: "生成中…",
  speakFailed: "朗读失败",
  speakTitle: "朗读译文",
  ttsSynthFailed: "语音合成失败",
  ttsPlayFailed: "音频播放失败",
  streamDisconnected: "翻译连接已断开",
  // 输入框翻译
  inputTranslateTitle: "翻译输入内容 / 还原原文",
  inputFailed: "失败",
  // 悬停角标 / FAB
  fabTitle: "打开翻译设置",
  dragTitle: "拖动移动工具条",
  // 工具条
  modeBilingual: "双语对照",
  modeTranslated: "仅译文",
  modeOriginal: "原文",
  toggleTranslate: "翻译",
  toggleRestore: "还原",
  copyAll: "复制译文",
  copyAllTitle: "复制整页译文到剪贴板",
  copyDiagnostic: "复制诊断信息",
  copyDiagnosticTitle: "复制脱敏的错误诊断信息（不含 API Key），便于反馈问题",
  collapseTitle: "收起为圆点",
  noTranslations: "暂无译文",
  copiedCount: (n: number) => `已复制 ${n} 段`,
  doneCount: (n: number) => `共 ${n} 段完成`,
  partialCount: (done: number, failed: number, err: string) =>
    `共 ${done} 段完成，${failed} 段失败${err ? `：${err}` : ""}`,
  notTranslated: "未翻译",
  noErrorInfo: "暂无错误信息",
  diagnosticCopied: "诊断信息已复制",
  // 诊断信息模板
  diagHeader: "[auto-translate 诊断]",
  diagError: "错误",
  diagErrorCode: "错误码",
  diagProvider: "通道",
  diagSource: "来源",
  diagSourceMain: "主 API",
  diagSourceBackup: "备用 API",
  diagEndpoint: "端点",
  diagHostname: "主机",
  diagHttpStatus: "HTTP 状态",
  // popup
  popupSaved: "已保存 ✔",
  popupTestRunning: "测试中…",
  popupTestOk: (msg: string) => `连接成功：${msg}`,
  popupTestFail: (err: string) => `连接失败：${err}`,
  popupUnknownError: "未知错误",
  popupNeedBaseUrl: "请填写 BaseURL 和模型",
  popupUnknownSite: "未知站点",
  popupNoSite: "无法获取当前站点",
  popupWhitelisted: (host: string) => `已加入白名单 ✔ ${host}`,
  popupBlacklisted: (host: string) => `已加入黑名单 ✔ ${host}`,
};

const en: Dict = {
  translate: "T",
  restore: "Restore",
  retry: "Retry",
  close: "Close",
  copy: "Copy",
  copyFailed: "Copy failed",
  bubbleTitle: "Translation",
  translating: "Translating…",
  translateFailed: "Translation failed",
  translateSelection: "Translate selection",
  speak: "Read aloud",
  stop: "Stop",
  speakGenerating: "Generating…",
  speakFailed: "TTS failed",
  speakTitle: "Read translation aloud",
  ttsSynthFailed: "Speech synthesis failed",
  ttsPlayFailed: "Audio playback failed",
  streamDisconnected: "Translation connection lost",
  inputTranslateTitle: "Translate input / restore original",
  inputFailed: "Failed",
  fabTitle: "Open translation settings",
  dragTitle: "Drag to move toolbar",
  modeBilingual: "Bilingual",
  modeTranslated: "Translation only",
  modeOriginal: "Original",
  toggleTranslate: "Translate",
  toggleRestore: "Restore",
  copyAll: "Copy translations",
  copyAllTitle: "Copy all translations on this page",
  copyDiagnostic: "Copy diagnostics",
  copyDiagnosticTitle: "Copy redacted error diagnostics (no API key) for bug reports",
  collapseTitle: "Collapse to dot",
  noTranslations: "Nothing translated yet",
  copiedCount: (n: number) => `Copied ${n} segments`,
  doneCount: (n: number) => `${n} segments done`,
  partialCount: (done: number, failed: number, err: string) =>
    `${done} done, ${failed} failed${err ? `: ${err}` : ""}`,
  notTranslated: "Not translated",
  noErrorInfo: "No error info",
  diagnosticCopied: "Diagnostics copied",
  diagHeader: "[auto-translate diagnostics]",
  diagError: "Error",
  diagErrorCode: "Error code",
  diagProvider: "Provider",
  diagSource: "Source",
  diagSourceMain: "Main API",
  diagSourceBackup: "Backup API",
  diagEndpoint: "Endpoint",
  diagHostname: "Host",
  diagHttpStatus: "HTTP status",
  popupSaved: "Saved ✔",
  popupTestRunning: "Testing…",
  popupTestOk: (msg: string) => `Connected: ${msg}`,
  popupTestFail: (err: string) => `Connection failed: ${err}`,
  popupUnknownError: "Unknown error",
  popupNeedBaseUrl: "Please fill in BaseURL and model",
  popupUnknownSite: "Unknown site",
  popupNoSite: "Cannot get current site",
  popupWhitelisted: (host: string) => `Added to whitelist ✔ ${host}`,
  popupBlacklisted: (host: string) => `Added to blacklist ✔ ${host}`,
};

/** 当前 UI 语言：浏览器语言 zh 开头 → 中文，否则英文 */
export type UiLang = "zh" | "en";

let lang: UiLang | null = null;

function currentLang(): UiLang {
  if (lang) return lang;
  try {
    const codes = typeof chrome !== "undefined" && chrome.i18n?.getUILanguage
      ? [chrome.i18n.getUILanguage()]
      : typeof navigator !== "undefined"
        ? navigator.languages ?? [navigator.language]
        : [];
    lang = codes.some((c) => /^zh/i.test(c)) ? "zh" : "en";
  } catch {
    lang = "zh";
  }
  return lang;
}

/** 测试用：覆盖语言判定（传 null 恢复自动判定） */
export function __setUiLang(l: UiLang | null): void {
  lang = l;
}

type Params = string | number;

/**
 * 取当前语言的文案。值可以是字符串或（带参数的）模板函数，
 * dict 缺键时回退中文表，再缺省回退 key 本身。
 */
export function t(key: string, ...params: Params[]): string {
  const table = currentLang() === "en" ? en : zh;
  let value: unknown = table[key] ?? zh[key] ?? key;
  if (typeof value === "function") value = value(...params);
  return String(value);
}
