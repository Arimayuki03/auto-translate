/**
 * TTS 播放管理：MV3 service worker 无 DOM 不能放音频，转发给 offscreen 文档播放。
 * offscreen 文档按需创建（单个，重复创建报错忽略）；「最新请求优先」——新播放先停旧播放。
 * 播放期间用 keepAlive 保活 SW：播放响应（播放结束/被停）可能远超 30s 空闲回收窗口。
 *
 * 停止代际（stopSeq）：ttsPlay 在 sendMessage 前有 await ensureOffscreenDocument()
 * 的异步窗口（offscreen 被回收时重建可达数百毫秒），期间用户停止会导致
 * it-tts-stop 先落地（此刻 current 还是 null，settle no-op）、随后 it-tts-play
 * 落地开始「孤儿播放」。每次 ttsStop 递增 stopSeq，ttsPlay 在每次真正发送
 * it-tts-play 前校验代际，被停止打断则不再发送。
 *
 * 在途登记（activePlayId）：存活信号 Port（content 侧播放期间建立）断开 =
 * 播放所在页面跳转/关闭/iframe 销毁 → 此时唯一能停播的就是本模块；
 * offscreen「最新请求优先」会打断旧播放，故断开时校验登记的仍是该请求才停，
 * 避免旧播放收尾断开 Port 误杀新播放。
 */
import type { TtsPlayMessage } from "../shared/messages";
import { beginKeepAlive, endKeepAlive } from "./keepAlive";

const OFFSCREEN_URL = "offscreen.html";
const OFFSCREEN_JUSTIFICATION = "播放扩展合成的朗读音频（页面 CSP 不影响扩展自身播放）";

let ensurePromise: Promise<void> | null = null;
/** 停止代际：每次 ttsStop 递增；ttsPlay 发送 it-tts-play 前校验防孤儿播放 */
let stopSeq = 0;
/** 当前在途播放的 requestId（同一时刻 offscreen 至多一条播放）；无在途时为 null */
let activePlayId: string | null = null;

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
  const myStop = stopSeq; // 记住进入时的停止代际：期间发生 ttsStop 则放弃发送
  // 入口即登记「最新请求」：存活信号 Port 在 ensureOffscreenDocument 窗口内断开
  // （页面跳转）也能命中并停播；发送前不重复设置（值相同）
  activePlayId = req.requestId;
  await ensureOffscreenDocument();
  // 先 begin 再进 try：保证 finally 的 endKeepAlive 严格配对（含停止门禁提前返回的路径）
  beginKeepAlive();
  try {
    if (stopSeq !== myStop) return { finished: false }; // ensure 窗口内被停止：不发，防孤儿播放
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
    if (stopSeq !== myStop) return { finished: false }; // 重试发送前同样校验
    const res = (await chrome.runtime.sendMessage({
      type: "it-tts-play",
      requestId: req.requestId,
      audioBase64: req.audioBase64,
      contentType: req.contentType,
    })) as { ok?: boolean; finished?: boolean; error?: string } | undefined;
    if (res?.ok) return { finished: !!res.finished };
    throw new Error(res?.error || "音频播放失败");
  } finally {
    // 仅当收尾的仍是本请求才清登记：新播放可能已顶替（「最新请求优先」）
    if (activePlayId === req.requestId) activePlayId = null;
    endKeepAlive();
  }
}

/** 停止当前播放（无在途播放 / offscreen 不存在时静默 no-op） */
export async function ttsStop(): Promise<void> {
  stopSeq++; // 作废所有在 ensure 窗口内、尚未发出的 it-tts-play（防孤儿播放）
  try {
    await chrome.runtime.sendMessage({ type: "it-tts-stop" });
  } catch (err) {
    if (!isMissingReceiverError(err)) throw err;
  }
}

/**
 * 存活信号 Port 断开（content 侧播放期间建立，页面跳转/关闭标签页/iframe 销毁时随帧断开）。
 * 断开的须仍是登记中的「最新请求」：旧播放被新播放打断后收尾断开 Port 不应误杀新播放。
 * 立即清登记（offscreen 回包可能永远不来）；it-tts-stop 在无在途播放时本就是 no-op。
 */
export function handleTtsLivenessDisconnect(requestId: string): void {
  if (activePlayId !== requestId) return;
  activePlayId = null;
  stopSeq++;
  void ttsStop();
}
