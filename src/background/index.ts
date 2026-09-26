import type {
  CancelTranslationMessage,
  CheckCacheMessage,
  ItCommandMessage,
  PageSummaryRequestMessage,
  PageSummaryResponseMessage,
  StreamPortMessage,
  StreamStartMessage,
  TestConnectionRequestMessage,
  TestConnectionResponseMessage,
  TtsPlayMessage,
  TtsSynthesizeMessage,
  TranslateRequestMessage,
  TranslateResponseMessage,
} from "../shared/messages";
import { STREAM_PORT_NAME } from "../shared/messages";
import type { ApiConfig } from "../shared/types";
import { getSettings } from "../shared/storage";
import { createProvider } from "./providers";
import { TranslateService, TranslationCancelledError } from "./translate";
import { ApiError } from "./providers/http";
import { beginKeepAlive, endKeepAlive } from "./keepAlive";
import {
  abortSession,
  registerSessionController,
  unregisterSessionController,
} from "./sessionRegistry";
import { synthesizeSpeech } from "./edgeTts";
import { handleTtsLivenessDisconnect, ttsPlay, ttsStop } from "./ttsPlayback";

console.log("[auto-translate] background service worker 已启动");

const translateService = new TranslateService();

/** 每日缓存清理 alarm：MV3 service worker 会被休眠，alarms 是唯一可靠的定时手段 */
const CACHE_CLEANUP_ALARM = "it-cache-cleanup";

function ensureCacheCleanupAlarm(): void {
  chrome.alarms.create(CACHE_CLEANUP_ALARM, { periodInMinutes: 24 * 60, delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener((details) => {
  console.log("[auto-translate] 安装/更新:", details.reason);
  ensureCacheCleanupAlarm();
});

// 浏览器重启后补挂 alarm（已存在时 create 会原样重置周期，幂等）
chrome.runtime.onStartup.addListener(() => {
  ensureCacheCleanupAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== CACHE_CLEANUP_ALARM) return;
  translateService
    .cleanupCache()
    .then((removed) => console.log(`[auto-translate] 每日缓存清理完成，移除 ${removed} 条`))
    .catch((err) => console.warn("[auto-translate] 缓存清理失败", err));
});

// 快捷键：把 chrome.commands 命令中继到当前标签页的 content script
chrome.commands.onCommand.addListener((command) => {
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const msg: ItCommandMessage = {
      type: "it-command",
      command: command as ItCommandMessage["command"],
    };
    await chrome.tabs.sendMessage(tab.id, msg).catch(() => undefined);
  })();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "translate") {
    const req = message as TranslateRequestMessage;
    const controller = new AbortController();
    // 会话按「发送方 tab+frame+sessionId」隔离：sessionId 是各 frame 从 0 起的代次，跨页会撞号（P0-3）
    registerSessionController(sender, req.sessionId, controller);
    // 整批翻译可能远超 SW 空闲回收窗口（30s）：在途期间周期性重置空闲计时器，
    // 否则 sendResponse 通道随 worker 一起被回收，整批结果丢失
    beginKeepAlive();
    translateService
      .translate(req.texts, req.targetLang, req.context, controller.signal)
      .then(
        (results) => sendResponse({ id: req.id, ok: true, results } as TranslateResponseMessage),
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
      .finally(() => {
        endKeepAlive();
        unregisterSessionController(sender, req.sessionId, controller);
      });
    return true;
  }

  // 中止「该标签页该 frame」指定会话的全部在途请求（content 还原/换页时发出）；
  // 其它标签页/iframe 的同值 sessionId 会话不受牵连（P0-3）
  if (message?.type === "cancel-translation") {
    const req = message as CancelTranslationMessage;
    abortSession(sender, req.sessionId);
    return false;
  }

  if (message?.type === "test-connection") {
    const req = message as TestConnectionRequestMessage;
    // 慢端点（首字延迟可超 30s）测试期间 SW 不能被发现空闲而回收：
    // worker 回收会带走 sendResponse 通道，popup/options 侧误报「连接失败」
    beginKeepAlive();
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
      )
      .finally(() => endKeepAlive());
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

  // ===== LLM 页面上下文摘要 =====

  // 生成/读取页面文章摘要（缓存优先）。随整页翻译会话中止（还原/换页时按 sessionId 一并中止）；
  // 失败静默返回空摘要：content 侧回退原文截断上下文，不阻塞翻译批次。
  if (message?.type === "page-summary") {
    const req = message as PageSummaryRequestMessage;
    const controller = new AbortController();
    registerSessionController(sender, req.sessionId, controller);
    beginKeepAlive();
    translateService
      .generatePageSummary(req.title, req.content, controller.signal)
      .then(
        (summary) => sendResponse({ id: req.id, ok: true, summary } as PageSummaryResponseMessage),
        (err) =>
          sendResponse({
            id: req.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          } as PageSummaryResponseMessage)
      )
      .finally(() => {
        endKeepAlive();
        unregisterSessionController(sender, req.sessionId, controller);
      });
    return true;
  }

  // 设置页「缓存管理」：显示磁盘层条目数
  if (message?.type === "cache-stats") {
    translateService
      .cacheStats()
      .then((count) => sendResponse({ count }))
      .catch((err) =>
        sendResponse({ count: 0, error: err instanceof Error ? err.message : String(err) })
      );
    return true;
  }

  // 设置页「立即清理」：手动触发一次过期/超额清理
  if (message?.type === "cleanup-cache") {
    translateService
      .cleanupCache()
      .then((removed) => sendResponse({ ok: true, removed }))
      .catch((err) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
      );
    return true;
  }

  // ===== 划词朗读 TTS =====

  // 合成：Edge TTS 免费（无 Key）；声音/语速按设置解析（用户显式声音 > 目标语言自动）
  if (message?.type === "tts-synthesize") {
    const req = message as TtsSynthesizeMessage;
    // 合成要跑两次外部请求（取令牌 + 合成音频，各自带硬超时），
    // 期间 SW 不能被发现空闲而回收，否则回包丢失、气泡永远不出声
    beginKeepAlive();
    getSettings()
      .then((settings) =>
        synthesizeSpeech(req.text, req.targetLang, {
          userVoice: settings.tts.voice,
          rate: settings.tts.rate,
        })
      )
      .then(
        ({ audioBase64, contentType }) =>
          sendResponse({ id: req.id, ok: true, audioBase64, contentType }),
        (err) =>
          sendResponse({
            id: req.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
      )
      .finally(() => endKeepAlive());
    return true;
  }

  // 播放：转发 offscreen 文档，播放结束/被停时回包
  if (message?.type === "tts-play") {
    const req = message as TtsPlayMessage;
    ttsPlay(req).then(
      ({ finished }) => sendResponse({ id: req.id, ok: true, finished }),
      (err) =>
        sendResponse({
          id: req.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
    );
    return true;
  }

  // 停止当前播放（气泡关闭 / 点「停止」）：无在途播放时 no-op，同步回包
  if (message?.type === "tts-stop") {
    ttsStop()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: true }));
    return true;
  }

  return undefined;
});

// ===== 划词流式翻译（Port 长连接网关）=====
// content 每次划词翻译建立一条 Port；background 执行流式翻译并把 provider 增量转发回 Port，
// 结束回传完整文本或错误。Port 断开（气泡关闭）→ AbortController 中止在途请求。
// ===== 划词朗读存活信号 Port =====
// name === "tts-play:<requestId>"：content 在播放期间持有，页面跳转/关闭标签页/iframe
// 销毁时随帧自动断开 → 停止朗读（offscreen 是浏览器级单例，不处理会播到自然结束）。
const TTS_PLAY_PORT_PREFIX = "tts-play:";

chrome.runtime.onConnect.addListener((port) => {
  // 朗读存活信号：一次性 Port，不收消息，仅 onDisconnect 有意义
  if (port.name?.startsWith(TTS_PLAY_PORT_PREFIX)) {
    const requestId = port.name.slice(TTS_PLAY_PORT_PREFIX.length);
    port.onDisconnect.addListener(() => handleTtsLivenessDisconnect(requestId));
    return;
  }
  if (port.name !== STREAM_PORT_NAME) return;
  const controller = new AbortController();
  let started = false;
  let finished = false;
  const post = (msg: StreamPortMessage): void => {
    try {
      port.postMessage(msg);
    } catch {
      // Port 已断开（气泡先关了）：静默丢弃；翻译照常收尾并写缓存
    }
  };
  port.onMessage.addListener((raw) => {
    if (started || finished) return; // 只认首条 start，重复消息忽略
    const msg = raw as StreamStartMessage;
    if (msg?.type !== "stream-start") return;
    started = true;
    // 流式首 delta 前可能长时间静默（排队限速/模型生成）：同样需要保活
    beginKeepAlive();
    translateService
      .translateStream(
        msg.text,
        msg.targetLang,
        (delta) => post({ type: "stream-delta", delta }),
        controller.signal
      )
      .then(
        (text) => {
          finished = true;
          post({ type: "stream-done", text });
          try {
            port.disconnect();
          } catch {
            // Port 可能已断开，收尾阶段的 disconnect 竞争属预期
          }
        },
        (err) => {
          finished = true;
          // 中止 = 用户关闭气泡 = Port 已断开：预期行为，静默结束不当作失败上报
          if (err instanceof TranslationCancelledError || controller.signal.aborted) return;
          post({
            type: "stream-error",
            error: err instanceof Error ? err.message : String(err),
            ...(err instanceof ApiError && err.code ? { errorCode: err.code } : {}),
            ...(err instanceof ApiError && err.diagnostic ? { diagnostic: err.diagnostic } : {}),
          });
          try {
            port.disconnect();
          } catch {
            // 同上
          }
        }
      )
      .finally(() => endKeepAlive());
  });
  port.onDisconnect.addListener(() => controller.abort());
});

async function testConnection(api: ApiConfig): Promise<string> {
  const provider = createProvider(api);
  // 免费通道的系统提示词约定与翻译一致（「翻译为X」），便于从中解析目标语言
  const isFree = api.format === "googlefree" || api.format === "microsoft";
  const prompt = isFree
    ? [
        {
          role: "system" as const,
          content: "你是专业翻译引擎。将用户输入翻译为zh-CN，只输出译文。",
        },
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
