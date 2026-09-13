/**
 * offscreen 音频播放器（普通 JS：public/ 下不经打包，保持零依赖）。
 * 与 background 的协议：
 *   { type: "it-tts-play", requestId, audioBase64, contentType } → 播放，结束/被停时回包
 *   { type: "it-tts-stop" } → 停止当前播放
 * 语义：全局同一时刻至多一条播放，「最新请求优先」——新 play 自动打断旧 play。
 */
"use strict";

let current = null; // { audio, url, resolve, settled }

function settle(result) {
  if (!current || current.settled) return;
  current.settled = true;
  const { audio, url, resolve } = current;
  current = null;
  try {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(url);
  } catch {
    /* 清理失败不影响回包 */
  }
  resolve(result);
}

function base64ToBytes(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function play(requestId, audioBase64, contentType) {
  // 最新请求优先：先停掉在途播放（旧请求以 stopped 回包）
  settle({ ok: true, finished: false });
  return new Promise((resolve) => {
    let entry = null;
    try {
      const bytes = base64ToBytes(audioBase64);
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      const url = URL.createObjectURL(new Blob([buffer], { type: contentType || "audio/mpeg" }));
      const audio = new Audio(url);
      entry = { audio, url, resolve, settled: false };
      current = entry;
      audio.onended = () => settle({ ok: true, finished: true });
      audio.onerror = () => settle({ ok: false, error: "音频解码/播放失败" });
      const p = audio.play();
      if (p && typeof p.catch === "function") {
        p.catch((err) => settle({ ok: false, error: (err && err.message) || "无法播放音频" }));
      }
    } catch (err) {
      if (entry) settle({ ok: false, error: (err && err.message) || String(err) });
      else resolve({ ok: false, error: (err && err.message) || String(err) });
    }
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return undefined;
  if (msg.type === "it-tts-play") {
    play(msg.requestId, msg.audioBase64, msg.contentType).then(sendResponse, (err) =>
      sendResponse({ ok: false, error: (err && err.message) || String(err) })
    );
    return true; // 异步回包
  }
  if (msg.type === "it-tts-stop") {
    settle({ ok: true, finished: false });
    sendResponse({ ok: true });
    return false;
  }
  return undefined;
});
