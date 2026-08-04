import type {
  CheckCacheMessage,
  ItCommandMessage,
  TestConnectionRequestMessage,
  TestConnectionResponseMessage,
  TranslateRequestMessage,
  TranslateResponseMessage,
} from "../shared/messages";
import type { ApiConfig } from "../shared/types";
import { createProvider } from "./providers";
import { TranslateService } from "./translate";

console.log("[auto-translate] background service worker 已启动");

const translateService = new TranslateService();

chrome.runtime.onInstalled.addListener((details) => {
  console.log("[auto-translate] 安装/更新:", details.reason);
});

// 快捷键：把 chrome.commands 命令中继到当前标签页的 content script
chrome.commands.onCommand.addListener((command) => {
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const msg: ItCommandMessage = { type: "it-command", command: command as ItCommandMessage["command"] };
    await chrome.tabs.sendMessage(tab.id, msg).catch(() => undefined);
  })();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "translate") {
    const req = message as TranslateRequestMessage;
    translateService
      .translate(req.texts, req.targetLang)
      .then(
        (results) =>
          sendResponse({ id: req.id, ok: true, results } as TranslateResponseMessage),
        (err) =>
          sendResponse({
            id: req.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          } as TranslateResponseMessage)
      );
    return true;
  }

  if (message?.type === "test-connection") {
    const req = message as TestConnectionRequestMessage;
    testConnection(req.api)
      .then(
        (reply) =>
          sendResponse({ id: req.id, ok: true, message: reply } as TestConnectionResponseMessage),
        (err) =>
          sendResponse({
            id: req.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          } as TestConnectionResponseMessage)
      );
    return true;
  }

  if (message?.type === "clear-cache") {
    translateService
      .clearCache()
      .then(() => sendResponse({ ok: true }))
      .catch((err) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
      );
    return true;
  }

  if (message?.type === "check-cache") {
    const req = message as CheckCacheMessage;
    translateService
      .checkCache(req.targetLang, req.texts)
      .then((cachedCount) => sendResponse({ cachedCount }))
      .catch((err) =>
        sendResponse({ cachedCount: 0, error: err instanceof Error ? err.message : String(err) })
      );
    return true;
  }

  return undefined;
});

async function testConnection(api: ApiConfig): Promise<string> {
  const provider = createProvider(api);
  const result = await provider.chat(
    [{ role: "user", content: "请只回复：连接成功" }],
    {
      baseUrl: api.baseUrl,
      apiKey: api.apiKey,
      model: api.model,
      temperature: 0,
      timeoutMs: api.timeoutMs,
    }
  );
  return result.text.trim();
}