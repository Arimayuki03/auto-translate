/** API 格式（适配器层支持）；googlefree / microsoft 为免 key 的免费翻译通道 */
export type ApiFormat = "openai" | "anthropic" | "gemini" | "ollama" | "googlefree" | "microsoft";

/** 批量翻译协议：旧版逐行协议默认兼容性最好；哨兵协议适合明确支持严格分隔输出的模型 */
export type BatchMode = "lines" | "separator";

/** 显示模式：双语对照 / 仅译文 / 原文 */
export type DisplayMode = "bilingual" | "translated" | "original";

/** 译文样式主题：灰字（默认）/ 描边（空心字）/ 虚线下划线 / 模糊（悬停显形） */
export type TranslationStyle = "gray" | "outline" | "underline" | "blur";

/** API 连接配置（主 / 备用共用） */
export interface ApiConfig {
  format: ApiFormat;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  maxConcurrency: number;
  /** 相邻两个请求的最小启动间隔（毫秒）：请求启动限速。中转站/服务商限额严格时调大 */
  minRequestIntervalMs?: number;
  /** 第三方 LLM 默认使用旧版逐行协议；Google 免费通道内部固定使用安全哨兵协议 */
  batchMode?: BatchMode;
  /** 用户自定义附加翻译指令：非空时拼在系统提示词最前面；
   *  批量协议的分段 / 逐行指令始终完整保留在其后，不会被覆盖（免费通道不使用） */
  customSystemPrompt?: string;
  /** Google 免费通道可选主/备用端点；留空使用内置公开端点 */
  freeEndpoint?: string;
  freeBackupEndpoint?: string;
}

/** 扩展设置（chrome.storage.local，apiKey 落盘前加密） */
export interface Settings {
  /** 设置结构版本（用于迁移默认值变更） */
  version?: number;
  api: ApiConfig;
  backupApi?: ApiConfig;
  translate: {
    targetLang: string;
    displayMode: DisplayMode;
    autoTranslate: boolean;
    autoDetectSource: boolean;
    minTextLength: number;
    blockMaxChars: number;
    translateOnSelect: boolean;
    translateInput: boolean;
    viewportLazy: boolean;
    terminology: string[];
    /** 页面上下文仅用于整页翻译；划词/输入框翻译不会携带 */
    contextEnabled?: boolean;
    /** 标题、描述、正文摘要合计最大字符数 */
    contextMaxChars?: number;
    /** 译文样式主题（灰字默认）；变更后下次注入页面生效 */
    style?: TranslationStyle;
    /** 用户自定义译文 CSS（附加在主题之上，限长由设置页钳制） */
    customCss?: string;
    /** 翻译 HTML 属性：placeholder / title / alt / aria-label（默认开启） */
    translateAttributes?: boolean;
  };
  sites: {
    whitelist: string[];
    blacklist: string[];
  };
  security: {
    encryptApiKey: boolean;
    sensitivePages: boolean;
  };
  cache: {
    enabled: boolean;
    maxEntries: number;
    /** 缓存条目保留天数（按写入时间淘汰）；0 = 永不过期 */
    ttlDays?: number;
  };
}
