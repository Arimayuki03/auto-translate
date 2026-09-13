import type { ApiConfig } from "../../shared/types";
import { anthropicProvider } from "./anthropic";
import { geminiProvider } from "./gemini";
import { googleFreeProvider } from "./googlefree";
import { microsoftProvider } from "./microsoft";
import { ollamaProvider } from "./ollama";
import { openaiProvider } from "./openai";
import type { Provider } from "./types";

const providers: Record<ApiConfig["format"], Provider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  ollama: ollamaProvider,
  googlefree: googleFreeProvider,
  microsoft: microsoftProvider,
};

export function createProvider(api: ApiConfig): Provider {
  const provider = providers[api.format];
  if (!provider) {
    throw new Error(`不支持的 API 格式：${api.format}`);
  }
  return provider;
}