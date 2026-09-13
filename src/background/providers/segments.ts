/** 免费通道（googlefree / microsoft）共用的消息解析。
 *  两家 provider 的输入形态一致（同一套 system/user 批量协议），解析逻辑保持一字不差；
 *  修改这里会同时影响两个免费通道。 */
import type { ChatMessage, ChatOptions } from "./types";

/** 从消息里提取目标语言：系统提示词含「翻译为X」，失败回退中文 */
export function extractTargetLang(messages: ChatMessage[]): string {
  const sys = messages.find((m) => m.role === "system")?.content ?? "";
  const m = sys.match(/翻译为([^，。\s]+)/);
  return m?.[1] ?? "zh-CN";
}

/** 从消息里提取待译片段；分隔协议由 TranslateService 显式传入，避免猜测正文内容。 */
export function extractSegments(messages: ChatMessage[], options: ChatOptions): string[] {
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  if ((options.batchSize ?? 1) <= 1) return [user];
  if (options.batchMode === "separator" && options.batchSeparator) {
    return user
      .split(options.batchSeparator)
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }
  return user.split(/\r?\n/).map((s) => s.trim());
}
