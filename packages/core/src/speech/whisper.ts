import { FRAME_SAMPLES } from '../audio/pcm.js';
import { EnergyVad, type SpeechSegment } from '../audio/vad.js';
import { encodeWavPcm16 } from '../audio/wav.js';
import { guessLang, guessMixed, normLang } from '../lang.js';
import { BaseSpeechStream, type SpeechProvider, type SpeechStream, type SpeechStreamOptions } from './provider.js';

export interface WhisperConfig {
  /** Server root, e.g. http://localhost:8000 for a local faster-whisper or whisper.cpp server. */
  baseUrl: string;
  /** Sent as "Authorization: Bearer" when the server needs one. */
  apiKey?: string;
  model?: string;
  /** Override for tests. */
  fetch?: typeof fetch;
}

const NAME_TO_CODE: Record<string, string> = {
  english: 'en', chinese: 'zh', mandarin: 'zh', cantonese: 'yue', japanese: 'ja', korean: 'ko', malay: 'ms', indonesian: 'id',
  thai: 'th', vietnamese: 'vi', hindi: 'hi', spanish: 'es', french: 'fr', german: 'de', portuguese: 'pt', arabic: 'ar', russian: 'ru',
};

/**
 * Speech provider for any server that implements the common
 * POST /v1/audio/transcriptions endpoint (multipart, response_format=verbose_json).
 * Each utterance found by the voice activity detector is transcribed on its own,
 * so every utterance gets its own language decision: per-segment language ID.
 */
export class WhisperSpeechProvider implements SpeechProvider {
  readonly id = 'whisper';
  readonly label = 'Whisper-compatible server';
  readonly detectsLanguage = true;
  constructor(private readonly cfg: WhisperConfig) {}

  async start(opts: SpeechStreamOptions): Promise<SpeechStream> {
    return new WhisperStream(this.cfg, opts);
  }
}

class WhisperStream extends BaseSpeechStream {
  private readonly vad: EnergyVad;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private wasSpeaking = false;

  constructor(private readonly cfg: WhisperConfig, private readonly opts: SpeechStreamOptions) {
    super();
    this.vad = new EnergyVad({ sampleRate: opts.sampleRate });
  }

  write(frame: Int16Array): void {
    if (this.closed) return;
    for (let i = 0; i < frame.length; i += FRAME_SAMPLES) {
      const seg = this.vad.push(frame.subarray(i, i + FRAME_SAMPLES));
      if (this.vad.isSpeaking && !this.wasSpeaking) this.result({ text: '', final: false });
      this.wasSpeaking = this.vad.isSpeaking;
      if (seg) this.enqueue(seg);
    }
  }

  private enqueue(seg: SpeechSegment) {
    if (seg.samples.length < this.opts.sampleRate * 0.3) return; // ignore clicks
    this.queue = this.queue.then(() => this.transcribe(seg)).catch(err => this.error(err instanceof Error ? err : new Error(String(err))));
  }

  private async transcribe(seg: SpeechSegment): Promise<void> {
    const f = this.cfg.fetch ?? fetch;
    const body = new FormData();
    body.append('file', new Blob([encodeWavPcm16(seg.samples, this.opts.sampleRate)], { type: 'audio/wav' }), 'utterance.wav');
    body.append('model', this.cfg.model ?? 'whisper-1');
    body.append('response_format', 'verbose_json');
    if (this.opts.phrases?.length) body.append('prompt', this.opts.phrases.join(', ').slice(0, 600));
    const res = await f(`${this.cfg.baseUrl.replace(/\/$/, '')}/v1/audio/transcriptions`, {
      method: 'POST', body, ...(this.cfg.apiKey ? { headers: { Authorization: `Bearer ${this.cfg.apiKey}` } } : {}),
    });
    if (!res.ok) throw new Error(`Speech server answered ${res.status}`);
    const json = (await res.json()) as { text?: unknown; language?: unknown };
    const text = typeof json.text === 'string' ? json.text.trim() : '';
    if (!text) return;
    const rawLang = typeof json.language === 'string' ? json.language.toLowerCase() : '';
    const lang = NAME_TO_CODE[rawLang] ?? normLang(rawLang) ?? guessLang(text);
    const langs = guessMixed(text);
    this.result({ text, final: true, lang, ...(langs ? { langs } : {}), start: seg.start, end: seg.end });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const seg = this.vad.flush();
    if (seg) this.enqueue(seg);
    await this.queue;
  }
}
