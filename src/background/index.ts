import type {
  CancelTranslationMessage,
  CheckCacheMessage,
  ItCommandMessage,
  TestConnectionRequestMessage,
  TestConnectionResponseMessage,
  TranslateRequestMessage,
  TranslateResponseMessage,
} from "../shared/messages";
import type { ApiConfig } from "../shared/types";
import { createProvider } from "./providers";
import { TranslateService, TranslationCancelledError } from "./translate";
import { ApiError } from "./providers/http";

console.log("[auto-translate] background service worker 已启动");

const translateService = new TranslateService();

/** 翻译会话 → 该会话在途请求的 AbortController。还原/换页时按会话批量中止，避免浪费额度。
 *  无 sessionId 的旧式请求（划词/输入框等）不参与会话中止。 */
const sessionControllers = new Map<number, Set<AbortController>>();

function registerController(sessionId: number | undefined, controller: AbortController): void {
  if (sessionId === undefined) return;
  let set = sessionControllers.get(sessionId);
  if (!set) sessionControllers.set(sessionId, (set = new Set()));
  set.add(controller);
}

function unregisterController(sessionId: number | undefined, controller: AbortController): void {
  if (sessionId === undefined) return;
  const set = sessionControllers.get(sessionId);
  if (!set) return;
  set.delete(controller);
  if (set.size === 0) sessionControllers.delete(sessionId);
}

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
    const controller = new AbortController();
    registerController(req.sessionId, controller);
    translateService
      .translate(req.texts, req.targetLang, req.context, controller.signal)
      .then(
        (results) =>
          sendResponse({ id: req.id, ok: true, results } as TranslateResponseMessage),
        (err) => {
          // 会话中止是用户主动还原/换页，属预期行为：静默返回，不当作失败上报
          if (err instanceof TranslationCancelledError) {
            sendResponse({ id: req.id, ok: false, error: "cancelled" } as TranslateResponseMessage);
            return;
          }
          sendResponse({
            id: req.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            // 错误类型 + 脱敏诊断，供内容侧工具条区分「主 API 鉴权失败 / 限流 / 免费通道」等
            ...(err instanceof ApiError && err.code ? { errorCode: err.code } : {}),
            ...(err instanceof ApiError && err.diagnostic ? { diagnostic: err.diagnostic } : {}),
          } as TranslateResponseMessage);
        }
      )
      .finally(() => unregisterController(req.sessionId, controller));
    return true;
  }

  // 中止某个翻译会话的全部在途请求（content 还原/换页时发出）
  if (message?.type === "cancel-translation") {
    const req = message as CancelTranslationMessage;
    const set = sessionControllers.get(req.sessionId);
    if (set) {
      for (const controller of set) controller.abort();
      sessionControllers.delete(req.sessionId);
    }
    return false;
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
            ...(err instanceof ApiError && err.code ? { errorCode: err.code } : {}),
            ...(err instanceof ApiError && err.diagnostic ? { diagnostic: err.diagnostic } : {}),
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
  // 免费通道的系统提示词约定与翻译一致（「翻译为X」），便于从中解析目标语言
  const prompt =
    api.format === "googlefree"
      ? [
          { role: "system" as const, content: "你是专业翻译引擎。将用户输入翻译为zh-CN，只输出译文。" },
          { role: "user" as const, content: "Connection test" },
        ]
      : [{ role: "user" as const, content: "请只回复：连接成功" }];
  const result = await provider.chat(prompt, {
    baseUrl: api.baseUrl,
    apiKey: api.apiKey,
    model: api.model,
    temperature: 0,
    timeoutMs: api.timeoutMs,
  });
  return result.text.trim();
}