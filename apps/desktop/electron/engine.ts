import {
  DEMO_MEETING, DemoClarity, DemoTranslator, FRAME_SAMPLES, LiveSession, newRoomCode, Resampler, RoomClient,
  ScriptedSpeechProvider, int16ToFloat, type Channel, type ClarityEngine, type DecodedWav, type LangCode, type Note,
  type Line, type PartialLine, type SpeechProvider, type Translator,
} from '@bibbly/core';
import { Claude, describeClaudeError } from '@bibbly/core/claude';
import { AzureSpeechProvider } from '@bibbly/core/speech/azure';
import { WhisperSpeechProvider } from '@bibbly/core/speech/whisper';
import type { ImportMeta, SessionEvent, StartOptions, StartResult } from '../src/shared/ipc.js';
import type { Secrets } from './secrets.js';
import type { DataStore } from './store.js';

const CHANNEL_SOURCE: Record<string, string> = { mic: 'Microphone', system: 'Meeting audio', stick: 'Bibbly Stick', demo: 'Demo meeting' };

/** Owns the live session in the main process, where API keys stay. */
export class SessionManager {
  private session: LiveSession | null = null;
  private room: RoomClient | null = null;
  private watched = new Set<LangCode>();
  private partial: PartialLine | null = null;

  constructor(private readonly store: DataStore, private readonly secrets: Secrets, private readonly send: (e: SessionEvent) => void) {}

  /** Claude for translation and notes, when a key or ANTHROPIC_API_KEY is available. */
  claude(): Claude | null {
    const key = this.secrets.get('anthropicKey') ?? process.env.ANTHROPIC_API_KEY;
    if (!key) return null;
    const s = this.store.data.settings;
    return new Claude({ apiKey: key, model: s.claudeModel, fast: s.fastMode });
  }

  private provider(): SpeechProvider {
    const s = this.store.data.settings;
    if (s.engine === 'azure') {
      const key = this.secrets.get('azureKey');
      if (!key) throw new Error('Add your Azure Speech key in Settings, or switch the speech engine.');
      return new AzureSpeechProvider({ key, region: s.azureRegion });
    }
    if (s.engine === 'whisper') {
      const apiKey = this.secrets.get('whisperKey');
      return new WhisperSpeechProvider({ baseUrl: s.whisperUrl, ...(apiKey ? { apiKey } : {}) });
    }
    throw new Error('Pick a speech engine in Settings to caption live audio. The demo meeting works without one.');
  }

  async start(o: StartOptions): Promise<StartResult> {
    if (this.session && !this.session.ended) await this.stop();
    const s = this.store.data.settings;
    const claude = this.claude();
    const warnings: string[] = [];
    const demo = o.mode === 'demo';
    const translator: Translator | null = demo ? new DemoTranslator(claude) : claude;
    const clarity: ClarityEngine | null = demo ? new DemoClarity(claude) : claude;
    if (!demo && !claude) warnings.push('Translation and notes need a Claude API key. Captions still work.');
    const sources = demo ? ['demo'] : (['mic', 'system', 'stick'] as const).filter(c => o.channels[c]);
    const session = new LiveSession({
      title: o.title ?? (demo ? DEMO_MEETING.title : 'Live session'), me: { id: 'me', name: s.myName || 'You', self: true }, myLang: s.myLang,
      candidateLanguages: [...new Set([s.myLang, ...s.speaking])], glossary: s.glossary, autoClarityEvery: 6,
      source: sources.map(c => CHANNEL_SOURCE[c]).join(' + '),
    }, { translator, clarity });
    this.session = session;
    this.watched.clear();
    session.on('line', line => { this.send({ type: 'line', line }); this.room?.caption({ id: line.id, t: line.t, speaker: line.speaker.name, text: line.text, lang: line.lang, ...(line.langs ? { langs: line.langs } : {}), ...(line.confidence != null ? { confidence: line.confidence } : {}) }); });
    session.on('partial', p => { this.partial = p.partial; this.send({ type: 'partial', channel: p.channel, partial: p.partial }); if (p.partial) this.room?.partial(p.partial.speaker.name, p.partial.text, p.partial.lang); });
    session.on('clarity', c => this.send({ type: 'clarity', clarity: c.clarity, title: c.title }));
    session.on('clarityStatus', c => this.send({ type: 'clarityStatus', state: c.state, ...(c.message ? { message: c.message } : {}) }));
    session.on('error', e => this.send({ type: 'error', source: e.source, message: e.source === 'speech' ? e.message : describeClaudeError(e.cause ?? new Error(e.message)) }));

    if (demo) {
      const script = DEMO_MEETING.lines.map(l => ({ at: l.t / 4.5, text: l.text, speakerId: l.speaker, lang: l.lang, ...(l.langs ? { langs: l.langs } : {}), confidence: l.confidence }));
      const speakers = Object.fromEntries(DEMO_MEETING.speakers.map(sp => [sp.id, sp.id === 'me' ? { id: 'me', name: s.myName || 'You', self: true } : { id: `demo:${sp.id}`, name: sp.name }]));
      await session.attach('demo', new ScriptedSpeechProvider(script, { wordMs: 120 }), { diarize: true, speakers });
    } else {
      const provider = this.provider();
      for (const ch of sources as Channel[]) await session.attach(ch, provider, { diarize: ch !== 'mic' });
    }

    let room: StartResult['room'] = null;
    if (o.shareRoom) room = this.openRoom();
    return { id: session.id, title: session.title, startedAt: session.startedAt, room, warnings };
  }

  private openRoom(): StartResult['room'] {
    const s = this.store.data.settings;
    const base = s.roomServer.replace(/\/$/, '');
    const code = newRoomCode();
    const ws = base.replace(/^http/, 'ws') + '/ws';
    const client = new RoomClient(ws, { room: code, role: 'host', name: s.myName || 'Host', lang: s.myLang, key: crypto.randomUUID() });
    client.on('message', m => { if (m.t === 'members') this.send({ type: 'room', members: m.members, connected: true }); });
    client.on('close', () => this.send({ type: 'room', members: [], connected: false }));
    client.connect();
    this.room = client;
    return { code, joinUrl: `${base}/join/${code}` };
  }

  frame(channel: Channel, pcm: ArrayBuffer): void {
    this.session?.write(channel, new Int16Array(pcm));
  }

  snapshot(): { lines: Line[]; partial: PartialLine | null } | null {
    return this.session ? { lines: this.session.lines.slice(-6), partial: this.partial } : null;
  }

  async summarize(): Promise<void> { await this.session?.summarize(false); }
  retry(lineId: string, lang: LangCode): void { this.session?.retry(lineId, lang); }

  /** Starts or stops translating into a language (the "Captions for" switcher). */
  watch(lang: LangCode, on: boolean): void {
    if (!this.session) return;
    if (on && !this.watched.has(lang)) { this.watched.add(lang); this.session.addTarget(lang); }
    if (!on && this.watched.delete(lang)) this.session.removeTarget(lang);
  }

  async translateNotes(lang: LangCode): Promise<void> { await this.session?.translateClarity(lang); }

  async stop(): Promise<Note | null> {
    const session = this.session;
    if (!session) return null;
    this.room?.end();
    this.room?.close();
    this.room = null;
    await session.stop();
    this.session = null;
    if (!session.lines.length) return null;
    const note = session.toNote();
    this.store.update({ notes: [note, ...this.store.data.notes.filter(n => n.id !== note.id)] });
    this.send({ type: 'ended', note });
    return note;
  }

  async discard(): Promise<void> {
    this.room?.close();
    this.room = null;
    this.session?.dispose();
    await this.session?.stop({ summarize: false });
    this.session = null;
  }

  /** Transcribes a recording imported from the Bibbly Stick into a new note. */
  async importRecording(wav: DecodedWav, meta: ImportMeta): Promise<Note> {
    const s = this.store.data.settings;
    const claude = this.claude();
    const session = new LiveSession({
      title: meta.title ?? 'Bibbly Stick recording', me: { id: 'me', name: s.myName || 'You', self: true }, myLang: s.myLang,
      candidateLanguages: [...new Set([s.myLang, ...s.speaking])], glossary: s.glossary, autoClarityEvery: 0, source: 'Bibbly Stick (offline recording)',
    }, { translator: claude, clarity: claude });
    await session.attach('stick', this.provider(), { diarize: true });
    const pcm = wav.sampleRate === 16_000 ? wav.samples : new Resampler(wav.sampleRate, 16_000).process(int16ToFloat(wav.samples));
    for (let i = 0; i < pcm.length; i += FRAME_SAMPLES * 10) session.write('stick', pcm.subarray(i, i + FRAME_SAMPLES * 10));
    await session.stop();
    const note = session.toNote({ startedAt: meta.startedAt || Date.now(), durationSec: Math.round(meta.durationMs / 1000) });
    this.store.update({ notes: [note, ...this.store.data.notes] });
    return note;
  }
}

