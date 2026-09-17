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
