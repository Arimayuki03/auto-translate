/**
 * 会话中止登记表（结论2 P0-3）：sessionId 是各 frame 引擎的代次（都从 0 起），
 * 必须按「发送方 tab + frame」隔离。旧实现用裸数字做键：同站两个标签页同时自动
 * 翻译（同为 generation 0）时，A 页还原发出的 cancel-translation 会 abort 掉
 * B 页全部在途请求，B 页整批误报「翻译失败」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Registry = typeof import("../src/background/sessionRegistry");

async function freshRegistry(): Promise<Registry> {
  vi.resetModules();
  return import("../src/background/sessionRegistry");
}

function sender(tabId: number | undefined, frameId?: number): chrome.runtime.MessageSender {
  return {
    tab: tabId === undefined ? undefined : ({ id: tabId } as unknown as chrome.tabs.Tab),
    frameId,
  };
}

describe("sessionRegistry 按 tab+frame 隔离", () => {
  let reg: Registry;
  beforeEach(async () => {
    reg = await freshRegistry();
  });

  it("不同标签页的同值 sessionId 互不中止", async () => {
    const a = new AbortController();
    const b = new AbortController();
    reg.registerSessionController(sender(1, 0), 0, a);
    reg.registerSessionController(sender(2, 0), 0, b);

    reg.abortSession(sender(1, 0), 0);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false); // 另一页的同代次会话安然无恙
  });

  it("同标签页不同 frame 的同值 sessionId 互不中止", async () => {
    const top = new AbortController();
    const inner = new AbortController();
    reg.registerSessionController(sender(7, 0), 0, top);
    reg.registerSessionController(sender(7, 12), 0, inner);

    reg.abortSession(sender(7, 0), 0);
    expect(top.signal.aborted).toBe(true);
    expect(inner.signal.aborted).toBe(false);
  });

  it("同会话多个请求全部中止；请求结束后摘除不再误伤", async () => {
    const c1 = new AbortController();
    const c2 = new AbortController();
    const s = sender(3, 0);
    reg.registerSessionController(s, 5, c1);
    reg.registerSessionController(s, 5, c2);
    reg.unregisterSessionController(s, 5, c1);

    reg.abortSession(s, 5);
    expect(c2.signal.aborted).toBe(true);
    expect(c1.signal.aborted).toBe(false); // 已完成的请求不在集合里
    // 中止后重复 abort 无害
    expect(() => reg.abortSession(s, 5)).not.toThrow();
  });

  it("无 sessionId 的旧式请求（划词/输入框）不参与会话中止", async () => {
    const c = new AbortController();
    reg.registerSessionController(sender(9, 0), undefined, c);
    reg.abortSession(sender(9, 0), 0);
    expect(c.signal.aborted).toBe(false);
  });

  it("无 tab 的发送方（设置页等）与标签页会话不互通", async () => {
    const noTab = new AbortController();
    const tab = new AbortController();
    reg.registerSessionController(sender(undefined, undefined), 0, noTab);
    reg.registerSessionController(sender(1, 0), 0, tab);

    reg.abortSession(sender(1, 0), 0);
    expect(tab.signal.aborted).toBe(true);
    expect(noTab.signal.aborted).toBe(false);
  });
});
