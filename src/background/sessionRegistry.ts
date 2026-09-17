/**
 * 翻译会话中止登记表。
 *
 * sessionId 是各 frame 引擎的「代次」（每个 frame 实例都从 0 起），只在本 frame 内有意义。
 * manifest 开启 all_frames 后，同一标签页的多个 frame、乃至不同标签页的引擎会产生
 * 完全相同的 sessionId —— 若按裸数字索引控制器（P0-3），A 页一次「还原」发出的
 * cancel-translation 会中止 B 页同代次会话的全部在途请求，B 页整批误报「翻译失败」。
 *
 * 因此以「发送方 tab + frame + sessionId」三元组为键：sender 由浏览器在 IPC 层盖章，
 * content 侧协议无需改动，天然不可伪造。
 */

type SessionSender = Pick<chrome.runtime.MessageSender, "tab" | "frameId">;

function sessionKeyOf(sender: SessionSender, sessionId: number): string {
  return `${sender.tab?.id ?? "no-tab"}:${sender.frameId ?? 0}:${sessionId}`;
}

const controllers = new Map<string, Set<AbortController>>();

/** 登记一个在途请求的控制器；sessionId 为空（划词/输入框等旧式请求）不参与会话中止 */
export function registerSessionController(
  sender: SessionSender,
  sessionId: number | undefined,
  controller: AbortController
): void {
  if (sessionId === undefined) return;
  const key = sessionKeyOf(sender, sessionId);
  let set = controllers.get(key);
  if (!set) controllers.set(key, (set = new Set()));
  set.add(controller);
}

/** 请求结束时摘除控制器；集合空了删键，防 Map 无界增长 */
export function unregisterSessionController(
  sender: SessionSender,
  sessionId: number | undefined,
  controller: AbortController
): void {
  if (sessionId === undefined) return;
  const set = controllers.get(sessionKeyOf(sender, sessionId));
  if (!set) return;
  set.delete(controller);
  if (set.size === 0) controllers.delete(sessionKeyOf(sender, sessionId));
}

/** 中止「该发送方」指定会话的全部在途请求；其它标签页/frame 的同值 sessionId 不受影响 */
export function abortSession(sender: SessionSender, sessionId: number): void {
  const key = sessionKeyOf(sender, sessionId);
  const set = controllers.get(key);
  if (!set) return;
  controllers.delete(key);
  for (const controller of set) controller.abort();
}
