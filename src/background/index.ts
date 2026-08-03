console.log("[auto-translate] background service worker 已启动");

chrome.runtime.onInstalled.addListener((details) => {
  console.log("[auto-translate] 安装/更新:", details.reason);
});

// 消息入口（阶段 2 起承载翻译请求：限流、批量合并、缓存、多格式适配）
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ping") {
    sendResponse({ ok: true, name: chrome.runtime.getManifest().name });
    return true;
  }
  return undefined;
});