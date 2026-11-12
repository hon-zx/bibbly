import type { LangCode } from '../types.js';
import { BaseSpeechStream, type SpeechProvider, type SpeechStream, type SpeechStreamOptions } from './provider.js';

export interface ScriptedUtterance { at: number; text: string; speakerId?: string; lang?: LangCode; langs?: LangCode[]; confidence?: number }

/**
 * Plays a script as if a speech engine were hearing it: partial results word by
 * word, then a final result. Used for the demo meeting, offline UI work and tests.
 * Audio written to the stream is ignored.
 */
export class ScriptedSpeechProvider implements SpeechProvider {
  readonly id = 'scripted';
  readonly label = 'Demo script';
  readonly detectsLanguage = true;

  constructor(private readonly script: ScriptedUtterance[], private readonly opts: { speed?: number; wordMs?: number; gapMs?: number; tailMs?: number } = {}) {}

  async start(_o: SpeechStreamOptions): Promise<SpeechStream> {
    return new ScriptedStream(this.script, this.opts.speed ?? 1, this.opts.wordMs ?? 110, this.opts.gapMs ?? 300, this.opts.tailMs ?? 200);
  }
}

class ScriptedStream extends BaseSpeechStream {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private closed = false;
  private done: Promise<void>;
  private finish!: () => void;

  constructor(script: ScriptedUtterance[], speed: number, wordMs: number, gapMs: number, tailMs: number) {
    super();
    this.done = new Promise(res => { this.finish = res; });
    let cursor = 0;
    script.forEach((u, idx) => {
      const tokens = /[぀-ヿ一-鿿]/.test(u.text)
        ? (u.text.match(/[぀-ヿ一-鿿　-〿＀-￯]{1,3}|[^぀-ヿ一-鿿　-〿＀-￯]+/g) ?? [u.text])
        : (u.text.match(/\S+\s*/g) ?? [u.text]);
      const startMs = Math.max(cursor, (u.at * 1000) / speed);
      tokens.forEach((_, i) => {
        this.timers.push(setTimeout(() => {
          if (this.closed) return;
          this.result({ text: tokens.slice(0, i + 1).join(''), final: false, start: u.at, ...(u.speakerId ? { speakerId: u.speakerId } : {}) });
        }, startMs + i * wordMs));
      });
      const endMs = startMs + tokens.length * wordMs + tailMs;
      this.timers.push(setTimeout(() => {
        if (this.closed) return;
        this.result({
          text: u.text, final: true, start: u.at, end: u.at + (endMs - startMs) / 1000,
          ...(u.speakerId ? { speakerId: u.speakerId } : {}), ...(u.lang ? { lang: u.lang } : {}),
          ...(u.langs ? { langs: u.langs } : {}), ...(u.confidence != null ? { confidence: u.confidence } : {}),
        });
        if (idx === script.length - 1) this.finish();
      }, endMs));
      cursor = endMs + gapMs;
    });
    if (!script.length) this.finish();
  }

  write(): void { /* audio is ignored by the script */ }

  async close(): Promise<void> {
    this.closed = true;
    this.timers.forEach(clearTimeout);
    this.finish();
    await this.done;
  }

  /** Resolves when the whole script has played. */
  finished(): Promise<void> { return this.done; }
}
