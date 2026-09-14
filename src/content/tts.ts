/** 划词朗读控制器：合成（background Edge TTS）→ 播放（offscreen）→ 状态机驱动气泡按钮。
 *  状态流转：idle → fetching（合成中）→ playing（播放中）→ idle；
 *  任何时刻的 stop()（点停止/气泡关闭）作废在途请求并停止播放；错误短暂显示后自动复位。 */
import type { TtsPlayResponseMessage, TtsSynthesizeResponseMessage } from "../shared/messages";
import { t } from "../shared/i18n";

export type TtsState = "idle" | "fetching" | "playing" | "error";

let msgSeq = 0;

export class TtsController {
  private state: TtsState = "idle";
  private gen = 0;
  private errorText = "";
  private errorTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onChange: (state: TtsState, errorText: string) => void) {}

  getState(): TtsState {
    return this.state;
  }

  private set(state: TtsState, errorText = ""): void {
    this.state = state;
    this.errorText = errorText;
    this.onChange(state, errorText);
  }

  /** 停止播放并作废在途合成（点「停止」或气泡关闭时调用；无在途时 no-op） */
  stop(): void {
    if (this.state === "idle" || this.state === "error") return;
    this.gen++;
    const wasPlaying = this.state === "playing";
    this.set("idle");
    if (wasPlaying) void this.sendStop();
  }

  /** 朗读 / 停止切换。text：要朗读的文本（气泡译文）；targetLang：用于自动选声音 */
  async toggle(text: string, targetLang: string): Promise<void> {
    if (this.state === "fetching") return; // 合成很快，不做半路停止
    if (this.state === "playing") {
      this.stop();
      return;
    }
    const g = ++this.gen;
    this.set("fetching");
    try {
      const synth = (await chrome.runtime.sendMessage({
        type: "tts-synthesize",
        id: `tts-s-${Date.now()}-${++msgSeq}`,
        text,
        targetLang,
      })) as TtsSynthesizeResponseMessage | undefined;
      if (g !== this.gen) return; // 期间被停止/关闭：丢弃结果不播放
      if (!synth?.ok || !synth.audioBase64) {
        throw new Error(synth?.error || t("ttsSynthFailed"));
      }
      this.set("playing");
      const play = (await chrome.runtime.sendMessage({
        type: "tts-play",
        id: `tts-p-${Date.now()}-${++msgSeq}`,
        requestId: crypto.randomUUID(),
        audioBase64: synth.audioBase64,
        contentType: synth.contentType ?? "audio/mpeg",
      })) as TtsPlayResponseMessage | undefined;
      if (g !== this.gen) return; // stop() 已把状态复位：不覆盖
      if (!play?.ok) throw new Error(play?.error || t("ttsPlayFailed"));
      this.set("idle");
    } catch (err) {
      if (g !== this.gen) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.set("error", msg);
      // 错误短暂显示后自动复位按钮
      clearTimeout(this.errorTimer);
      this.errorTimer = setTimeout(() => {
        if (this.state === "error" && g === this.gen) this.set("idle");
      }, 3000);
    }
  }

  private async sendStop(): Promise<void> {
    try {
      await chrome.runtime.sendMessage({ type: "tts-stop" });
    } catch {
      // 无在途播放 / offscreen 不存在：停止本就是 no-op，忽略
    }
  }
}
