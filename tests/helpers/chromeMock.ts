/** 测试共享助手：安装/卸载全局 chrome mock。
 *  背景：Vitest 的 worker 会跨测试文件复用 globalThis（streaming.test.ts 注释已自省过），
 *  约 26 个测试文件在 beforeEach 安装 chrome mock 却从不清理，一旦 node 环境文件与
 *  jsdom 文件被池调度进同一 worker，残留 mock 会造成"单跑绿、全跑红/绿"的隐性假绿。
 *  本助手提供统一的安装与卸载入口，卸载必须在 afterEach 调用。 */

export interface ChromeMockOptions {
  /** storage.local 的初始内存（get 返回该对象，set 写回该对象） */
  storage?: Record<string, unknown>;
  /** 额外的 chrome API 覆盖（如 runtime.sendMessage、tabs 等） */
  extra?: Record<string, unknown>;
}

export interface ChromeMockHandle {
  /** 可读写的内存存储，便于用例断言最终落盘内容 */
  memory: Record<string, unknown>;
  /** chrome.storage.local.get 的 spy */
  getMock: ReturnType<typeof import("vitest").vi.fn>;
  /** chrome.storage.local.set 的 spy */
  setMock: ReturnType<typeof import("vitest").vi.fn>;
  /** 完整的 chrome mock 对象（便于追加自定义 API） */
  chrome: Record<string, unknown>;
}

/** 安装 chrome mock，返回操作句柄。必须在 afterEach 配对调用 uninstallChromeMock。 */
export function installChromeMock(options: ChromeMockOptions = {}): ChromeMockHandle {
  const memory: Record<string, unknown> = options.storage ? { ...options.storage } : {};
  const getMock = async (key?: string | string[] | null) => {
    if (key == null) return { ...memory };
    if (typeof key === "string") return { [key]: memory[key] };
    const out: Record<string, unknown> = {};
    for (const k of key) out[k] = memory[k];
    return out;
  };
  const setMock = async (items: Record<string, unknown>) => {
    Object.assign(memory, items);
  };
  const chrome: Record<string, unknown> = {
    storage: {
      local: { get: getMock, set: setMock },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    runtime: {
      getManifest: () => ({ version: "1.0.0" }),
      sendMessage: async () => ({ ok: true }),
    },
    ...options.extra,
  };
  (globalThis as { chrome?: unknown }).chrome = chrome;
  return { memory, getMock: getMock as ChromeMockHandle["getMock"], setMock: setMock as ChromeMockHandle["setMock"], chrome };
}

/** 卸载 chrome mock，恢复 globalThis。必须在 afterEach 调用。 */
export function uninstallChromeMock(): void {
  delete (globalThis as { chrome?: unknown }).chrome;
}
