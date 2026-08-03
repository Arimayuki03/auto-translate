/** 内容侧翻译服务：术语表占位 → 发 background → 回填（气泡/输入框/引擎统一入口） */
import type { TranslateRequestMessage, TranslateResponseMessage } from "../shared/messages";

let msgSeq = 0;

const TOKEN_RE = /⟦(\d+)⟧/g;

/**
 * 翻译一组文本。
 * 术语表非空时，先把术语替换为 ⟦n⟧ 占位 token（保证模型不改写），译文再换回原术语。
 * 失败时 throw（错误信息来自 background 或连接异常）。
 */
export async function translateTexts(
  texts: string[],
  targetLang: string,
  glossary: string[]
): Promise<string[]> {
  const { tokenized, restore } = tokenizeGlossary(texts, glossary);

  const req: TranslateRequestMessage = {
    type: "translate",
    id: `ct-${Date.now()}-${++msgSeq}`,
    texts: tokenized,
    targetLang,
  };

  let res: TranslateResponseMessage;
  try {
    res = (await chrome.runtime.sendMessage(req)) as TranslateResponseMessage;
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
  if (!res || !res.ok || !res.results) {
    throw new Error(res?.error ?? "翻译请求失败");
  }
  return res.results.map((r) => restore(r));
}

/** 术语表占位：把每个术语替换为 ⟦n⟧，返回恢复函数（词序打乱，仅原地替换） */
export function tokenizeGlossary(
  texts: string[],
  glossary: string[]
): { tokenized: string[]; restore: (s: string) => string } {
  const terms = [...glossary]
    .filter((t) => t.trim().length > 0)
    .sort((a, b) => b.length - a.length); // 长术语先替换，避免短术语误伤长术语子串

  if (terms.length === 0) {
    return { tokenized: texts, restore: (s) => s };
  }

  const tokenized = texts.map((t) => {
    let out = t;
    for (let i = 0; i < terms.length; i++) {
      out = out.split(terms[i]).join(`⟦${i}⟧`);
    }
    return out;
  });

  const restore = (s: string): string =>
    s.replace(TOKEN_RE, (m, idx) => terms[Number(idx)] ?? m);

  return { tokenized, restore };
}
