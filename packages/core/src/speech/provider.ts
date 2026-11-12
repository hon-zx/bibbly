import type { LangCode } from '../types.js';

/** One recognition result from a speech engine. */
export interface SpeechResult {
  text: string;
  /** False while the phrase is still being spoken. */
  final: boolean;
  /** Language the engine detected for this phrase. */
  lang?: LangCode;
  langs?: LangCode[];
  confidence?: number;
  /** Engine speaker label when diarization is on, e.g. "Guest-1". */
  speakerId?: string;
  /** Seconds since the stream started. */
  start?: number;
  end?: number;
}

export interface SpeechStreamOptions {
  sampleRate: number;
  /** Languages people in this meeting may speak (engines that need hints use these). */
  candidateLanguages: LangCode[];
  /** Ask the engine to label different speakers. */
  diarize?: boolean;
  /** Names and terms to bias recognition towards. */
  phrases?: string[];
}

export interface SpeechStream {
  /** Pushes 16-bit mono PCM at the agreed sample rate. */
  write(frame: Int16Array): void;
  /** Stops listening; resolves after the last final result is delivered. */
  close(): Promise<void>;
  onResult(cb: (r: SpeechResult) => void): () => void;
  onError(cb: (e: Error) => void): () => void;
}

export interface SpeechProvider {
  readonly id: string;
  readonly label: string;
  /** True when the engine identifies the language of every phrase by itself. */
  readonly detectsLanguage: boolean;
  start(opts: SpeechStreamOptions): Promise<SpeechStream>;
}

/** Shared listener bookkeeping for stream implementations. */
export abstract class BaseSpeechStream implements SpeechStream {
  private results = new Set<(r: SpeechResult) => void>();
  private errors = new Set<(e: Error) => void>();

  abstract write(frame: Int16Array): void;
  abstract close(): Promise<void>;

  onResult(cb: (r: SpeechResult) => void): () => void { this.results.add(cb); return () => this.results.delete(cb); }
  onError(cb: (e: Error) => void): () => void { this.errors.add(cb); return () => this.errors.delete(cb); }
  protected result(r: SpeechResult): void { for (const cb of [...this.results]) cb(r); }
  protected error(e: Error): void { for (const cb of [...this.errors]) cb(e); }
}
