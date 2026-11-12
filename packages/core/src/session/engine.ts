import { lineText } from '../export/index.js';
import { guessLang, guessMixed } from '../lang.js';
import type { ClarityEngine, Translator } from '../llm/types.js';
import type { SpeechProvider, SpeechResult, SpeechStream } from '../speech/provider.js';
import type { Channel, Clarity, ClarityItem, LangCode, Line, Note, PartialLine, SpeakerRef } from '../types.js';
import { Emitter, uid } from '../util.js';

export interface SessionConfig {
  id?: string;
  title?: string;
  /** The person using this device. */
  me: SpeakerRef;
  /** Language the notes are written in (the user's caption language). */
  myLang: LangCode;
  /** Languages people may speak; engines that need hints use them. */
  candidateLanguages: LangCode[];
  glossary?: string[];
  /** Refresh the notes after this many new lines (0 turns it off). */
  autoClarityEvery?: number;
  /** Human-readable capture source stored on the note. */
  source?: string;
  now?: () => number;
}

export interface SessionDeps {
  translator?: Translator | null;
  clarity?: ClarityEngine | null;
}

export type SessionEvents = {
  line: Line;
  partial: { channel: Channel; partial: PartialLine | null };
  translation: { lineId: string; lang: LangCode };
  clarity: { clarity: Clarity; title: string };
  clarityStatus: { state: 'idle' | 'working' | 'error'; message?: string };
  error: { source: 'speech' | 'translate' | 'clarity'; message: string; cause?: unknown };
  status: { state: 'live' | 'ended' };
};

interface ChannelState {
  stream: SpeechStream;
  speakers: Map<string, SpeakerRef>;
  fallback: SpeakerRef;
  detects: boolean;
  unsubs: (() => void)[];
}

const BATCH = 6;
const MAX_INFLIGHT = 2;

/**
 * A live captioning session. Each channel (mic, meeting audio, the Stick) feeds
 * its own speech stream; settled phrases become lines; every line is translated
 * once per target language; Clarity notes refresh as the meeting goes.
 */
export class LiveSession extends Emitter<SessionEvents> {
  readonly id: string;
  title: string;
  readonly startedAt: number;
  readonly lines: Line[] = [];
  clarity: Clarity | null = null;
  ended = false;

  private readonly byId = new Map<string, Line>();
  private readonly channels = new Map<Channel, ChannelState>();
  private readonly targets = new Map<LangCode, number>();
  private readonly queue = new Map<LangCode, Set<string>>();
  private readonly timers = new Map<LangCode, ReturnType<typeof setTimeout>>();
  private readonly inflight = new Map<LangCode, number>();
  private readonly failed = new Set<string>();
  private readonly abort = new AbortController();
  private sinceClarity = 0;
  private clarityRunning: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(readonly cfg: SessionConfig, private readonly deps: SessionDeps = {}) {
    super();
    this.now = cfg.now ?? Date.now;
    this.id = cfg.id ?? uid('s_');
    this.title = cfg.title ?? 'Live session';
    this.startedAt = this.now();
    this.addTarget(cfg.myLang);
  }

  /** Seconds since the session started. */
  elapsed(): number { return (this.now() - this.startedAt) / 1000; }

  setTranslator(t: Translator | null): void { this.deps.translator = t; }
  setClarityEngine(c: ClarityEngine | null): void { this.deps.clarity = c; }

  /** Translate every line into `lang` from now on (reference-counted). */
  addTarget(lang: LangCode): void {
    this.targets.set(lang, (this.targets.get(lang) ?? 0) + 1);
    for (const l of this.lines) this.enqueue(l, lang);
  }

  removeTarget(lang: LangCode): void {
    const n = (this.targets.get(lang) ?? 0) - 1;
    if (n <= 0 && lang !== this.cfg.myLang) this.targets.delete(lang); else this.targets.set(lang, Math.max(1, n));
  }

  get targetLanguages(): LangCode[] { return [...this.targets.keys()]; }

  /** Starts a speech stream for a channel. */
  async attach(channel: Channel, provider: SpeechProvider, opts: { diarize?: boolean; speaker?: SpeakerRef; speakers?: Record<string, SpeakerRef> } = {}): Promise<void> {
    if (this.channels.has(channel)) await this.detach(channel);
    const stream = await provider.start({
      sampleRate: 16_000, candidateLanguages: this.cfg.candidateLanguages, diarize: !!opts.diarize, phrases: this.cfg.glossary ?? [],
    });
    const fallback = opts.speaker ?? (channel === 'mic' || channel === 'stick' ? this.cfg.me : { id: `${channel}`, name: 'Meeting audio' });
    const state: ChannelState = { stream, speakers: new Map(Object.entries(opts.speakers ?? {})), fallback, detects: provider.detectsLanguage, unsubs: [] };
    state.unsubs.push(stream.onResult(r => this.onResult(channel, state, r)));
    state.unsubs.push(stream.onError(e => this.emit('error', { source: 'speech', message: e.message, cause: e })));
    this.channels.set(channel, state);
  }

  async detach(channel: Channel): Promise<void> {
    const st = this.channels.get(channel);
    if (!st) return;
    this.channels.delete(channel);
    await st.stream.close().catch(() => undefined);
    st.unsubs.forEach(u => u());
    this.emit('partial', { channel, partial: null });
  }

  /** Pushes 16 kHz mono PCM for a channel. */
  write(channel: Channel, frame: Int16Array): void {
    if (!this.ended) this.channels.get(channel)?.stream.write(frame);
  }

  private speakerFor(channel: Channel, st: ChannelState, speakerId?: string): SpeakerRef {
    if (!speakerId) return st.fallback;
    let s = st.speakers.get(speakerId);
    if (!s) {
      const n = [...st.speakers.values()].filter(v => /^(Guest|Speaker) \d+$/.test(v.name)).length + 1;
      const base = channel === 'system' ? 'Guest' : 'Speaker';
      s = channel === 'mic' && n === 1 && st.fallback.self ? st.fallback : { id: `${channel}:${speakerId}`, name: `${base} ${n}` };
      st.speakers.set(speakerId, s);
    }
    return s;
  }

  private onResult(channel: Channel, st: ChannelState, r: SpeechResult): void {
    const speaker = this.speakerFor(channel, st, r.speakerId);
    if (!r.final) {
      this.emit('partial', { channel, partial: { channel, speaker, text: r.text, ...(r.lang ? { lang: r.lang } : {}), t: r.start ?? this.elapsed() } });
      return;
    }
    this.emit('partial', { channel, partial: null });
    const text = r.text.trim();
    if (!text) return;
    const lang = r.lang ?? guessLang(text, this.cfg.myLang);
    const langs = r.langs ?? guessMixed(text) ?? undefined;
    this.addLine({
      t: r.start ?? Math.max(0, this.elapsed() - 2), ...(r.end != null ? { end: r.end } : {}), speaker, channel, text, lang,
      ...(langs ? { langs } : {}), ...(r.confidence != null ? { confidence: r.confidence } : {}),
    }, st.detects);
  }

  /** Adds a settled line (also used for room captions, the demo, and imports). */
  addLine(init: Omit<Line, 'id' | 'tr'> & { id?: string; tr?: Record<LangCode, string> }, detected = true): Line {
    const line: Line = { ...init, id: init.id ?? uid('l_'), tr: { ...(init.tr ?? {}) } };
    if (this.byId.has(line.id)) return this.byId.get(line.id)!;
    if (!detected) line.confidence = undefined;
    this.lines.push(line);
    this.byId.set(line.id, line);
    this.emit('line', line);
    for (const lang of this.targets.keys()) this.enqueue(line, lang);
    this.sinceClarity++;
    const every = this.cfg.autoClarityEvery ?? 6;
    if (every > 0 && this.sinceClarity >= every && !this.clarityRunning) void this.summarize(false);
    return line;
  }

  /** Attaches a translation that arrived from elsewhere (e.g. the rooms server). */
  setTranslation(lineId: string, lang: LangCode, text: string): void {
    const line = this.byId.get(lineId);
    if (!line) return;
    line.tr[lang] = text;
    this.emit('line', line);
    this.emit('translation', { lineId, lang });
  }

  isFailed(lineId: string, lang: LangCode): boolean { return this.failed.has(`${lineId}|${lang}`); }

  retry(lineId: string, lang: LangCode): void {
    this.failed.delete(`${lineId}|${lang}`);
    const line = this.byId.get(lineId);
    if (line) this.enqueue(line, lang);
  }

  private enqueue(line: Line, lang: LangCode): void {
    if (!this.deps.translator || !lineText(line, lang).missing || this.failed.has(`${line.id}|${lang}`)) return;
    let q = this.queue.get(lang);
    if (!q) this.queue.set(lang, (q = new Set()));
    q.add(line.id);
    if (!this.timers.has(lang)) this.timers.set(lang, setTimeout(() => { this.timers.delete(lang); void this.flush(lang); }, 120));
  }

  private async flush(lang: LangCode): Promise<void> {
    const q = this.queue.get(lang);
    const translator = this.deps.translator;
    if (!q?.size || !translator) return;
    if ((this.inflight.get(lang) ?? 0) >= MAX_INFLIGHT) { this.timers.set(lang, setTimeout(() => { this.timers.delete(lang); void this.flush(lang); }, 250)); return; }
    const ids = [...q].slice(0, BATCH);
    ids.forEach(id => q.delete(id));
    const items = ids.map(id => this.byId.get(id)).filter((l): l is Line => !!l && lineText(l, lang).missing);
    if (!items.length) return;
    const firstIdx = this.lines.indexOf(items[0]!);
    const context = this.lines.slice(Math.max(0, firstIdx - 8), firstIdx).map(l => `${l.speaker.name}: ${l.text}`);
    this.inflight.set(lang, (this.inflight.get(lang) ?? 0) + 1);
    try {
      const results = await translator.translate({
        target: lang, title: this.title, glossary: this.cfg.glossary ?? [], context,
        items: items.map(l => ({ id: l.id, text: l.text, speaker: l.speaker.name })),
      }, this.abort.signal);
      const got = new Set<string>();
      for (const r of results) {
        const line = this.byId.get(r.id);
        if (!line) continue;
        got.add(r.id);
        line.tr[lang] = r.translation;
        if (line.confidence === undefined && r.lang) {
          line.lang = r.lang;
          if (r.langs.length > 1) line.langs = r.langs; else delete line.langs;
          if (r.confidence != null) line.confidence = r.confidence;
          // A corrected source language may make this translation unnecessary.
          if (line.lang === lang && !line.langs) delete line.tr[lang];
        }
        this.emit('line', line);
        this.emit('translation', { lineId: line.id, lang });
      }
      for (const l of items) if (!got.has(l.id)) this.failed.add(`${l.id}|${lang}`);
    } catch (err) {
      if (this.abort.signal.aborted) return;
      for (const l of items) this.failed.add(`${l.id}|${lang}`);
      this.emit('error', { source: 'translate', message: err instanceof Error ? err.message : String(err), cause: err });
    } finally {
      this.inflight.set(lang, Math.max(0, (this.inflight.get(lang) ?? 1) - 1));
      if (this.queue.get(lang)?.size && !this.timers.has(lang)) this.timers.set(lang, setTimeout(() => { this.timers.delete(lang); void this.flush(lang); }, 60));
    }
  }

  /** Refreshes the notes. Resolves when done; errors are emitted, not thrown. */
  summarize(final = false): Promise<void> {
    const engine = this.deps.clarity;
    if (!engine || !this.lines.length) return Promise.resolve();
    if (this.clarityRunning && !final) return this.clarityRunning;
    this.sinceClarity = 0;
    const run = (async () => {
      this.emit('clarityStatus', { state: 'working' });
      try {
        const res = await engine.summarize({
          lang: this.cfg.myLang, title: this.title, me: this.cfg.me.name, startedAt: this.startedAt, final,
          lines: this.lines.map(l => ({ id: l.id, t: Math.round(l.t), speaker: l.speaker.self ? `${l.speaker.name} (me)` : l.speaker.name, text: l.text })),
        }, final ? undefined : this.abort.signal);
        this.clarity = res.clarity;
        if (this.title === 'Live session' || final) this.title = res.title;
        this.emit('clarity', { clarity: res.clarity, title: this.title });
        this.emit('clarityStatus', { state: 'idle' });
      } catch (err) {
        if (this.abort.signal.aborted && !final) return;
        const message = err instanceof Error ? err.message : String(err);
        this.emit('clarityStatus', { state: 'error', message });
        this.emit('error', { source: 'clarity', message, cause: err });
      }
    })();
    const p: Promise<void> = run.finally(() => { if (this.clarityRunning === p) this.clarityRunning = null; });
    this.clarityRunning = p;
    return p;
  }

  /** Translates the current notes into another language (for listeners or a language switch). */
  async translateClarity(lang: LangCode): Promise<void> {
    const c = this.clarity;
    const translator = this.deps.translator;
    if (!c || !translator) return;
    const items: { id: string; item: ClarityItem }[] = [];
    c.summary.forEach((it, i) => items.push({ id: `s${i}`, item: it }));
    c.decisions.forEach((it, i) => items.push({ id: `d${i}`, item: it }));
    c.actions.forEach(a => items.push({ id: a.id, item: a }));
    if (c.followup) items.push({ id: 'f', item: c.followup });
    const todo = items.filter(x => !x.item.text[lang]);
    if (!todo.length) return;
    const res = await translator.translate({ target: lang, title: this.title, items: todo.map(x => ({ id: x.id, text: x.item.text[x.item.src] ?? '' })) });
    for (const r of res) { const x = todo.find(t => t.id === r.id); if (x) x.item.text[lang] = r.translation; }
    this.emit('clarity', { clarity: c, title: this.title });
  }

  async stop(opts: { summarize?: boolean } = {}): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await Promise.all([...this.channels.keys()].map(ch => this.detach(ch)));
    this.emit('status', { state: 'ended' });
    if (opts.summarize !== false) await this.summarize(true);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Cancels pending translations and notes requests (on discard). */
  dispose(): void {
    this.abort.abort();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  toNote(extra: Partial<Note> = {}): Note {
    const speakers = new Map<string, SpeakerRef>();
    for (const l of this.lines) speakers.set(l.speaker.id, l.speaker);
    const languages = [...new Set(this.lines.flatMap(l => l.langs ?? [l.lang]))];
    const last = this.lines[this.lines.length - 1];
    return {
      id: this.id, title: this.title, startedAt: this.startedAt,
      durationSec: Math.max(Math.round(this.elapsed()), last ? Math.round(last.end ?? last.t + 5) : 0),
      source: this.cfg.source ?? 'Bibbly', languages, speakers: [...speakers.values()],
      lines: this.lines.map(l => ({ ...l, tr: { ...l.tr } })), clarity: this.clarity, sentTo: [], ...extra,
    };
  }
}
