/**
 * 2026-09-18 第三轮审查 P0 修复的回归用例。
 * 每条都对应一个「实现被破坏后必须变红」的具体性质：
 *  1. API Key 落盘混淆对任意 Unicode 成立，绝不退化成明文写盘；v1 历史值仍可解出。
 *  2. blockMaxChars 越界（0/负数）被导入校验剔除，且切分函数自身有兜底，不再无限循环。
 *  3. host 通配符不再拼正则：病态模式线性返回，`*.domain` 语义保持。
 *  4. 不可重试的 API 硬失败（401）短路，不把 1 次失败放大成 1+N 次。
 *  5. Gemini 的 Key 走请求头，不出现在 URL 里。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decryptApiKey,
  encryptApiKey,
  getSettings,
  importSettings,
  DEFAULT_SETTINGS,
  SETTING_RANGES,
} from "../src/shared/storage";
import type { Settings } from "../src/shared/types";
import { splitBySentences } from "../src/content/extractor";
import { urlMatchesPattern } from "../src/shared/siteRules";
import { TranslateService } from "../src/background/translate";
import { geminiProvider } from "../src/background/providers/gemini";

// ===== 存储桩 =====

type Store = Record<string, unknown>;

function installChromeStore(store: Store) {
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: unknown) => {
          if (typeof key === "string") return { [key]: store[key] };
          return { ...store };
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, JSON.parse(JSON.stringify(items)));
        }),
        remove: vi.fn(async (key: unknown) => {
          delete store[typeof key === "string" ? key : ""];
        }),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  } as unknown as typeof chrome;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (globalThis as { chrome?: unknown }).chrome;
});

// ===== 1. API Key 落盘混淆 =====

describe("API Key 落盘混淆", () => {
  it("含非 Latin-1 字符的 Key 不会退化成明文写盘", () => {
    // 旧实现在 UTF-16 码元上 XOR 后 btoa，遇中文 Key 抛错 → catch 直接返回明文原文。
    const plain = "sk-密钥-测试-äöü";
    const encoded = encryptApiKey(plain);
    expect(encoded).not.toBe(plain);
    // 落盘值不得包含任何一段可辨识的原文
    expect(encoded).not.toContain("密钥");
    expect(encoded).not.toContain(plain);
    expect(decryptApiKey(encoded)).toBe(plain);
  });

  it("纯 ASCII Key 往返一致", () => {
    expect(decryptApiKey(encryptApiKey("sk-abc123XYZ"))).toBe("sk-abc123XYZ");
  });

  it("v1 历史落盘值仍可解出（升级不丢用户的 Key）", () => {
    // v1 算法：UTF-16 码元 XOR + btoa，前缀 "at-v1:"
    const legacyXor = (text: string): string =>
      Array.from(text)
        .map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ (0x5a ^ (i & 0xff))))
        .join("");
    const legacyStored = btoa(legacyXor("at-v1:sk-old-key"));
    expect(decryptApiKey(legacyStored)).toBe("sk-old-key");
    // 解出的明文再存一次即得到新的 v2 编码（与 v1 落盘值不同，且仍能正确解回）
    const upgraded = encryptApiKey(decryptApiKey(legacyStored));
    expect(upgraded).not.toBe(legacyStored);
    expect(decryptApiKey(upgraded)).toBe("sk-old-key");
  });

  it("非混淆形态的值按明文原样返回（历史明文 / 用户手填不报错）", () => {
    expect(decryptApiKey("sk-plain-not-base64_")).toBe("sk-plain-not-base64_");
    expect(encryptApiKey("")).toBe("");
    expect(decryptApiKey("")).toBe("");
  });

  it("saveSettings 落盘后的磁盘值不含明文 Key", async () => {
    const store: Store = {};
    installChromeStore(store);
    await importSettings({ api: { format: "openai", apiKey: "sk-秘密-key" } });
    const settings = (store.settings ?? {}) as { api?: { apiKey?: string } };
    expect(settings.api?.apiKey).toBeDefined();
    expect(settings.api?.apiKey).not.toContain("秘密");
    expect(settings.api?.apiKey).not.toBe("sk-秘密-key");
    expect((await getSettings()).api.apiKey).toBe("sk-秘密-key");
  });
});

// ===== 2. blockMaxChars 越界不再导致死循环 =====

describe("SETTING_RANGES 区间契约", () => {
  // 防止有人只改一处：UI 保存钳制、导入校验、options.html 的 min/max 三者共用这份常量
  it("关键区间与 UI 输入框能力一致", () => {
    expect(SETTING_RANGES.maxConcurrency).toEqual([1, 10]);
    expect(SETTING_RANGES.timeoutMs).toEqual([5000, 300_000]);
    // UI 按秒输入（min=5 max=300），落盘乘 1000 后须恰好落在 ms 区间内
    expect(SETTING_RANGES.timeoutSeconds).toEqual([5, 300]);
    expect(SETTING_RANGES.timeoutMs[0]).toBe(SETTING_RANGES.timeoutSeconds[0] * 1000);
    expect(SETTING_RANGES.timeoutMs[1]).toBe(SETTING_RANGES.timeoutSeconds[1] * 1000);
    expect(SETTING_RANGES.minRequestIntervalMs).toEqual([50, 10_000]);
    expect(SETTING_RANGES.temperature).toEqual([0, 2]);
    expect(SETTING_RANGES.blockMaxChars).toEqual([100, 5000]);
  });
});

describe("blockMaxChars 越界防护", () => {
  const longText = "句子。".repeat(500); // 远超任何 maxChars，必然进入切分循环

  it("splitBySentences 收到 0 / 负数 / NaN 时仍会终止", () => {
    // 旧实现 `for (let i = 0; i < t.length; i += maxChars)` 在 maxChars<=0 时永不推进
    for (const bad of [0, -1, -1200, NaN, Infinity]) {
      const started = Date.now();
      const chunks = splitBySentences(longText, bad);
      expect(Date.now() - started, `maxChars=${bad} 耗时过长`).toBeLessThan(1000);
      expect(chunks.length).toBeGreaterThan(0);
      // 切分结果必须无损可还原（不吞字）
      expect(chunks.join("").replace(/ /g, "")).toBe(longText.replace(/ /g, ""));
    }
  });

  it("导入文件里的 blockMaxChars: 0 被剔除，回退到既有值", async () => {
    const store: Store = {
      settings: structuredClone({
        ...DEFAULT_SETTINGS,
        translate: { ...DEFAULT_SETTINGS.translate, blockMaxChars: 1200 },
      }),
    };
    installChromeStore(store);
    await importSettings({ translate: { blockMaxChars: 0 } });
    expect((await getSettings()).translate.blockMaxChars).toBe(1200);
    await importSettings({ translate: { blockMaxChars: -50 } });
    expect((await getSettings()).translate.blockMaxChars).toBe(1200);
  });

  it("合法范围内的 blockMaxChars 正常生效", async () => {
    const store: Store = { settings: structuredClone(DEFAULT_SETTINGS) };
    installChromeStore(store);
    await importSettings({ translate: { blockMaxChars: 300 } });
    expect((await getSettings()).translate.blockMaxChars).toBe(300);
  });
});

// ===== 3. host 通配符：无回溯 + 语义保持 =====

describe("host 通配符匹配", () => {
  it("病态模式线性返回，不再灾难性回溯", () => {
    // 旧实现拼成 `[a-z0-9.-]*a[a-z0-9.-]*a...` 后 new RegExp：实测 6 组通配符 4.2s、8 组 187s。
    // 样本刻意只取 5-6 组（回归时约 1-4s，用例干净地超时失败），
    // 不能放 8 组——那样一旦回归就是挂起 3 分钟而不是失败，CI 上更糟。
    const started = Date.now();
    for (const pattern of [
      "*a*a*a*a*a*b",
      "*a*a*a*a*a*a*b",
      "*-*-*-*-*-*-*.com",
    ]) {
      urlMatchesPattern(new URL("https://" + "a".repeat(60) + ".com/"), pattern);
    }
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("*.domain 仍匹配主域自身与任意层级子域", () => {
    const hit = (host: string, pattern: string) =>
      urlMatchesPattern(new URL(`https://${host}/page`), pattern);
    expect(hit("wikipedia.org", "*.wikipedia.org")).toBe(true);
    expect(hit("en.wikipedia.org", "*.wikipedia.org")).toBe(true);
    expect(hit("a.b.c.wikipedia.org", "*.wikipedia.org")).toBe(true);
    expect(hit("notwikipedia.org", "*.wikipedia.org")).toBe(false);
    expect(hit("wikipedia.org.evil.com", "*.wikipedia.org")).toBe(false);
  });

  it("精确与后缀语义保持不变", () => {
    const hit = (host: string, pattern: string) =>
      urlMatchesPattern(new URL(`https://${host}/`), pattern);
    expect(hit("github.com", "github.com")).toBe(true);
    expect(hit("gist.github.com", "github.com")).toBe(true);
    expect(hit("sub.example.com", "*.example.com")).toBe(true);
    expect(hit("example.com", "*")).toBe(true);
    expect(hit("example.com", "example*")).toBe(true);
    expect(hit("example.org", "example*")).toBe(true); // 旧正则同为前缀通配，语义一致
    expect(hit("example.org", "*x.com")).toBe(false);
  });

  it("路径规则按大小写不敏感与解码后形态匹配", () => {
    expect(urlMatchesPattern(new URL("https://a.com/Docs/intro"), "a.com/docs")).toBe(true);
    expect(urlMatchesPattern(new URL("https://a.com/docs/intro"), "a.com/docs")).toBe(true);
    expect(urlMatchesPattern(new URL("https://a.com/docslong"), "a.com/docs")).toBe(false);
    expect(
      urlMatchesPattern(new URL("https://a.com/" + encodeURIComponent("文档") + "/x"), "a.com/文档")
    ).toBe(true);
    // 模式侧带百分号编码（从地址栏复制）同样要命中：URL 侧解码，模式侧也须解码
    expect(
      urlMatchesPattern(new URL("https://a.com/文档/x"), "a.com/%E6%96%87%E6%A1%A3")
    ).toBe(true);
    // 两侧都不解码的畸形转义按字面原样比对，不抛错
    expect(urlMatchesPattern(new URL("https://a.com/%zz"), "a.com/%zz")).toBe(true);
  });
});

// ===== 4. 不可重试硬失败短路 =====

describe("批次硬失败短路", () => {
  function hardFailSettings(): Settings {
    return {
      version: DEFAULT_SETTINGS.version,
      enabled: true,
      api: {
        format: "openai",
        baseUrl: "https://example.test/v1",
        apiKey: "sk-test",
        model: "m",
        temperature: 0.3,
        timeoutMs: 60000,
        maxConcurrency: 4,
        minRequestIntervalMs: 50,
        batchMode: "lines",
        customSystemPrompt: "",
        freeEndpoint: "",
        freeBackupEndpoint: "",
      },
      translate: { ...DEFAULT_SETTINGS.translate, blockMaxChars: 1200 },
      sites: { ...DEFAULT_SETTINGS.sites },
      tts: { ...DEFAULT_SETTINGS.tts },
      security: { ...DEFAULT_SETTINGS.security },
      cache: { enabled: false, maxEntries: 100, ttlDays: 7 },
    };
  }

  beforeEach(() => {
    const settings = hardFailSettings();
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        local: {
          get: vi.fn(async () => ({ settings })),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
    } as unknown as typeof chrome;
  });

  it("整批 401 只发 1 次请求，不再逐段重发（30 段 ≠ 31 次 401）", async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount++;
        return new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    const texts = Array.from({ length: 30 }, (_, i) => `paragraph number ${i} with some words`);
    const svc = new TranslateService();
    await expect(svc.translate(texts, "zh-CN")).rejects.toThrow();
    // 短路前这里是 1 + 30 = 31 次；每段还要过一遍请求启动限速
    expect(fetchCount).toBe(1);
  });

  it("404（模型不存在）同样短路", async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount++;
        return new Response(JSON.stringify({ error: { message: "model not found" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    const texts = Array.from({ length: 12 }, (_, i) => `text ${i} here`);
    await expect(new TranslateService().translate(texts, "zh-CN")).rejects.toThrow();
    expect(fetchCount).toBe(1);
  });
});

// ===== 5. Gemini Key 不进 URL =====

describe("Gemini 鉴权位置", () => {
  it("Key 走 x-goog-api-key 请求头，URL 里没有 key 参数", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: "你好" }] } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );
    await geminiProvider.chat([{ role: "user", content: "hello" }], {
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "g-secret-key",
      model: "gemini-pro",
      temperature: 0.3,
      timeoutMs: 60000,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/v1beta/models/gemini-pro:generateContent");
    expect(calls[0].url).not.toContain("g-secret-key");
    expect(calls[0].url).not.toContain("key=");
    const headers = (calls[0].init.headers ?? {}) as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("g-secret-key");
  });
});

// ===== 6. 2026-09-20 第五轮审查修复：A2 部分成功 / B1 硬失败通道切换 / C8 429 惩罚保持 =====

/** 五轮修复用例共用的设置桩：openai 格式、可选备用 API（默认未配置） */
function fifthRoundSettings(backup?: Settings["api"]): Settings {
  return {
    version: DEFAULT_SETTINGS.version,
    enabled: true,
    api: {
      format: "openai",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
      model: "m",
      temperature: 0.3,
      timeoutMs: 60000,
      maxConcurrency: 4,
      minRequestIntervalMs: 50,
      batchMode: "lines",
      customSystemPrompt: "",
      freeEndpoint: "",
      freeBackupEndpoint: "",
    },
    ...(backup ? { backupApi: backup } : {}),
    translate: { ...DEFAULT_SETTINGS.translate, blockMaxChars: 1200 },
    sites: { ...DEFAULT_SETTINGS.sites },
    tts: { ...DEFAULT_SETTINGS.tts },
    security: { ...DEFAULT_SETTINGS.security },
    cache: { enabled: false, maxEntries: 100, ttlDays: 7 },
  };
}

function mockSettingsStorage(settings: Settings): void {
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(async () => ({ settings })),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    },
  } as unknown as typeof chrome;
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** A2 变异自检（验收要求）：批量 3 段中 2 段成功 1 段失败 →
 *  results 保留 2 段译文、不整批 throw（旧实现 allFailed 判 pending.every(=="") 恒真，
 *  会把已成功的段落一并作废、整批上抛——本用例钉住该回归）。 */
describe("A2 部分成功不整批丢弃", () => {
  beforeEach(() => mockSettingsStorage(fifthRoundSettings()));
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('批量 3 段：2 段批量成功 1 段逐段失败 → 返回 [译, 译, ""] 而非 reject', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { messages: { content: string }[] };
        const user = body.messages[1].content as string;
        if (user.includes("\n")) {
          // 整批批量请求：正常回 3 行（批量成功）
          return ok({ choices: [{ message: { content: "译一\n译二\n译三" } }] });
        }
        // 单段请求：一段翻译用户故意 500（重试耗尽后写 ""）
        return new Response("boom", { status: 500 });
      })
    );
    // 前置缓存为空：3 段都进入批量
    const svc = new TranslateService();
    const results = await svc.translate(["一", "二", "三"], "zh-CN");
    expect(results).toEqual(["译一", "译二", "译三"]);
  });

  it("逐段兜底 3 段中 2 段成功 1 段失败：保留 2 段译文，不整批 throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { messages: { content: string }[] };
        const user = body.messages[1].content as string;
        // 整批批量请求：只回 1 行 → splitBatch null（批量解析失败），且段数 <8 不拆小批量，直接逐段
        if (user.includes("\n")) return ok({ choices: [{ message: { content: "乱掉了" } }] });
        // 逐段：第二段一直 500，其余成功
        if (user === "二") return new Response("boom", { status: 500 });
        return ok({ choices: [{ message: { content: `译${user}` } }] });
      })
    );
    const svc = new TranslateService();
    const results = await svc.translate(["一", "二", "三"], "zh-CN");
    // 部分成功：成功段保留译文；失败段写 ""；绝不整批 throw
    expect(results).toEqual(["译一", "", "译三"]);
  });

  it("全部段失败仍整批抛错（allFailed 语义不回退）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("server down", { status: 500 }))
    );
    const svc = new TranslateService();
    // 2 段批量失败（withRetry: 1+3 次）→ 逐段兜底各再 4 次，全程约 16 次退避（≤60s 封顶）
    await expect(svc.translate(["一", "二"], "zh-CN")).rejects.toThrow(/500|服务端/);
  }, 30_000);
});

/** B1：主通道硬失败（401 等）时备用通道仍要被启用——
 *  旧实现降级链被 isRetryable 拦死，硬失败下备用/免费互切永不尝试。 */
describe("B1 主通道硬失败仍走备用通道", () => {
  const backup = { ...fifthRoundSettings().api, baseUrl: "https://backup.test/v1" };

  beforeEach(() => mockSettingsStorage(fifthRoundSettings(backup)));
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("单段：主 API 401 → 切备用 API 成功返回（旧实现 1 次请求即抛）", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.startsWith("https://backup.test")) {
          return ok({ choices: [{ message: { content: "备用译文" } }] });
        }
        return new Response("unauthorized", { status: 401 });
      })
    );
    const svc = new TranslateService();
    const results = await svc.translate(["hello"], "zh-CN");
    expect(results).toEqual(["备用译文"]);
    expect(calls[0]).toContain("example.test");
    expect(calls[calls.length - 1]).toContain("backup.test");
  });

  it("通道内级联短路保持：主 API 401 不做同通道重试（主失败 1 次 + 备用 N 段）", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.startsWith("https://backup.test")) {
          return ok({ choices: [{ message: { content: "备一\n备二" } }] });
        }
        return new Response("unauthorized", { status: 401 });
      })
    );
    const svc = new TranslateService();
    const results = await svc.translate(["一", "二"], "zh-CN");
    expect(results).toEqual(["备一", "备二"]);
    const mainCalls = calls.filter((u) => u.startsWith("https://example.test")).length;
    const backupCalls = calls.filter((u) => u.startsWith("https://backup.test")).length;
    // 主通道硬失败不重试：批量 1 次即切；备用通道 1 次批量成功
    expect(mainCalls).toBe(1);
    expect(backupCalls).toBe(1);
  });

  it("全候选都硬失败：抛最后（备用）通道的 401，不放大请求数", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response("unauthorized", { status: 401 });
      })
    );
    const svc = new TranslateService();
    const texts = Array.from({ length: 6 }, (_, i) => `段${i}`);
    await expect(svc.translate(texts, "zh-CN")).rejects.toThrow("401");
    // 整批主 1 次 + 备用 1 次（均硬失败短路，不逐段放大）
    expect(calls).toHaveLength(2);
  });
});

/** C8：429「容量降到 1」的后探针惩罚在一次暂停期内不被后续 configureChannels 抹掉。
 *  旧实现：翻译入口每次都调 configureChannels 重设 min(maxConcurrency,16)，
 *  暂停期的 capacity=1 被覆盖，暂停一到期立即恢复满容量 burst。 */
describe("C8 暂停期通道容量不被 configureChannels 抹掉", () => {
  beforeEach(() => mockSettingsStorage(fifthRoundSettings()));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("translate 之间触发 configureChannels，暂停中的通道容量仍钳在 1", async () => {
    vi.useFakeTimers();
    // 暴露内部限速器：借双层断言拿 channels 私有字段做状态断言
    const svc = new TranslateService();
    const internals = svc as unknown as {
      channels: Map<
        string,
        {
          bucket: { tryAcquire(): number; configure(rate: number, capacity: number): void };
          pausedUntil: number;
        }
      >;
    };
    const key = "openai|https://example.test/v1";
    const run = (async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ok({ choices: [{ message: { content: "译" } }] }))
      );
      // 第 1 次翻译：建通道并触发 configureChannels
      await svc.translate(["a"], "zh-CN");
    })();
    await vi.runAllTimersAsync();
    await run;
    expect(internals.channels.get(key)).toBeDefined();

    // 模拟 429 惩罚：容量降到 1、暂停 30s（与 pauseRateLimit 相同的写法）
    const ch = internals.channels.get(key)!;
    ch.pausedUntil = Date.now() + 30_000;
    // 手工把桶容量压到 1（configure(rate,1) 的效果）
    (svc as unknown as { channelRate: number }).channelRate = 2;
    ch.bucket.configure(2, 1);

    // 第 2 次翻译（触发 configureChannels 重设容量）：暂停期内容量不得被恢复
    const run2 = (async () => {
      await svc.translate(["b"], "zh-CN");
    })();
    await vi.runAllTimersAsync();
    await run2;

    // 暂停已过 30s、时间仍在暂停窗口内：桶一次只能放行 1 个请求
    vi.advanceTimersByTime(10_000);
    expect(ch.bucket.tryAcquire()).toBe(0);
    expect(ch.bucket.tryAcquire()).toBeGreaterThan(0);

    // 暂停到期后的下一次翻译：configureChannels 正常恢复容量
    vi.advanceTimersByTime(25_000); // 越过 pausedUntil
    const run3 = (async () => {
      await svc.translate(["c"], "zh-CN");
    })();
    await vi.runAllTimersAsync();
    await run3;
    // configure 只钳制不补满（既有语义）：空闲 60s 让令牌按新容量补满
    vi.advanceTimersByTime(60_000);
    // 容量恢复（maxConcurrency=4 → capacity 4）：连续 4 个请求立即放行
    expect(ch.bucket.tryAcquire()).toBe(0);
    expect(ch.bucket.tryAcquire()).toBe(0);
    expect(ch.bucket.tryAcquire()).toBe(0);
    expect(ch.bucket.tryAcquire()).toBe(0);
  });
});
