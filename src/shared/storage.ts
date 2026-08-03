import type { Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  api: {
    format: "openai",
    baseUrl: "",
    apiKey: "",
    model: "",
    temperature: 0.3,
    timeoutMs: 60000,
    maxConcurrency: 3,
  },
  translate: {
    targetLang: "zh-CN",
    displayMode: "bilingual",
    autoTranslate: true,
    autoDetectSource: true,
    minTextLength: 4,
    blockMaxChars: 1200,
    translateOnSelect: true,
    translateInput: true,
    terminology: [],
  },
  sites: { whitelist: [], blacklist: [] },
  security: { encryptApiKey: true, sensitivePages: true },
  cache: { enabled: true, maxEntries: 5000 },
};

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get("settings");
  const saved = stored.settings as Partial<Settings> | undefined;
  return mergeSettings(DEFAULT_SETTINGS, saved ?? {});
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

function mergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  return {
    ...base,
    ...patch,
    api: { ...base.api, ...(patch.api ?? {}) },
    translate: { ...base.translate, ...(patch.translate ?? {}) },
    sites: { ...base.sites, ...(patch.sites ?? {}) },
    security: { ...base.security, ...(patch.security ?? {}) },
    cache: { ...base.cache, ...(patch.cache ?? {}) },
  };
}