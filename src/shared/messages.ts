import type { ApiConfig } from "./types";

export interface TranslateRequestMessage {
  type: "translate";
  id: string;
  texts: string[];
  targetLang: string;
}

export interface TranslateResponseMessage {
  id: string;
  ok: boolean;
  results?: string[];
  error?: string;
}

export interface TestConnectionRequestMessage {
  type: "test-connection";
  id: string;
  api: ApiConfig;
}

export interface TestConnectionResponseMessage {
  id: string;
  ok: boolean;
  message?: string;
  error?: string;
}

/** 快捷键命令：background → content（chrome.commands 中继） */
export interface ItCommandMessage {
  type: "it-command";
  command: "toggle-translate" | "cycle-mode";
}

/** 清空译文缓存（设置页 → background） */
export interface ClearCacheMessage {
  type: "clear-cache";
}