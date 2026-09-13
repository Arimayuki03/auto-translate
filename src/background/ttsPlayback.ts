/**
 * TTS 播放管理：MV3 service worker 无 DOM 不能放音频，转发给 offscreen 文档播放。
 * offscreen 文档按需创建（单个，重复创建报错忽略）；「最新请求优先」——新播放先停旧播放。
 * 播放期间用 keepAlive 保活 SW：播放响应（播放结束/被停）可能远超 30s 空闲回收窗口。
 */
import type { TtsPlayMessage } from "../shared/messages";
import { beginKeepAlive, endKeepAlive } from "./keepAlive";

const OFFSCREEN_URL = "offscreen.html";
const OFFSCREEN_JUSTIFICATION = "播放扩展合成的朗读音频（页面 CSP 不影响扩展自身播放）";

let ensurePromise: Promise<void> | null = null;

function isMissingReceiverError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Could not establish connection") ||
    msg.includes("Receiving end does not exist") ||
    msg.includes("No response")
  );
}

function isDuplicateOffscreenError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Only a single offscreen document") ||
    msg.includes("already exists") ||
    msg.includes("Singleton offscreen document")
  );
}

async function hasOffscreenDocument(): Promise<boolean> {
  if (typeof chrome.runtime?.getContexts !== "function") return false;
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    return contexts.some((c) => c.contextType === chrome.runtime.ContextType.OFFSCREEN_DOCUMENT);
  } catch {
    return false;
  }
}

/** 确保 offscreen 文档存在（并发调用共享同一次创建；「已存在」视为成功） */
async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: OFFSCREEN_JUSTIFICATION,
      });
    } catch (err) {
      if (!isDuplicateOffscreenError(err)) throw err;
    }
  })().finally(() => {
    ensurePromise = null;
  });
  return ensurePromise;
}

/**
 * 播放一段已合成的音频：转发给 offscreen 文档，播放结束 / 被停止时 resolve。
 * offscreen 文档可能被浏览器回收（接收端暂不存在）：重建后重试一次。
 */
export async function ttsPlay(req: TtsPlayMessage): Promise<{ finished: boolean }> {
  await ensureOffscreenDocument();
  beginKeepAlive();
  try {
    const res = (await chrome.runtime.sendMessage({
      type: "it-tts-play",
      requestId: req.requestId,
      audioBase64: req.audioBase64,
      contentType: req.contentType,
    })) as { ok?: boolean; finished?: boolean; error?: string } | undefined;
    if (res?.ok) return { finished: !!res.finished };
    throw new Error(res?.error || "音频播放失败");
  } catch (err) {
    if (!isMissingReceiverError(err)) throw err;
    // offscreen 被回收：重建后重试一次
    await ensureOffscreenDocument();
    const res = (await chrome.runtime.sendMessage({
      type: "it-tts-play",
      requestId: req.requestId,
      audioBase64: req.audioBase64,
      contentType: req.contentType,
    })) as { ok?: boolean; finished?: boolean; error?: string } | undefined;
    if (res?.ok) return { finished: !!res.finished };
    throw new Error(res?.error || "音频播放失败");
  } finally {
    endKeepAlive();
  }
}

/** 停止当前播放（无在途播放 / offscreen 不存在时静默 no-op） */
export async function ttsStop(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "it-tts-stop" });
  } catch (err) {
    if (!isMissingReceiverError(err)) throw err;
  }
}
