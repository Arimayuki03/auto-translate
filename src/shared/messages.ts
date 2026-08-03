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