/**
 * Live captions on the phone, in three ways:
 *   mic   - this phone listens; Bibbly transcribes, detects each language and translates
 *   demo  - the scripted demo meeting (works offline, no keys)
 *   room  - join a meeting someone is captioning on Bibbly desktop: captions arrive
 *           translated into your language by the rooms server
 */
import {
  DEMO_MEETING, DemoClarity, DemoTranslator, LiveSession, RoomClient, ScriptedSpeechProvider, guessLang, uid,
  type Clarity, type LangCode, type Line, type Member, type Note, type PartialLine, type WireLine,
} from '@bibbly/core';
import { describeClaudeError } from '@bibbly/core/claude';
import { PermissionsAndroid, Platform } from 'react-native';
import { addErrorListener, addFramesListener, micAvailable, startMic, stopMic } from '../modules/bibbly-audio';
import { pcmFromBase64 } from './base64';
import { claude, NO_SPEECH_ENGINE, speechProvider } from './services';
import { getData, saveNote } from './store';

export type LiveMode = 'mic' | 'demo' | 'room';

export interface LiveState {
  status: 'idle' | 'starting' | 'live' | 'stopping';
  mode: LiveMode | null;
  title: string;
  startedAt: number;
  lines: Line[];
  partial: PartialLine | null;
  clarity: Clarity | null;
  /** Language the captions are shown in (defaults to Settings > my language). */
  captionLang: LangCode;
  room: { code: string; members: Member[]; connected: boolean } | null;
  notice: string | null;
  lastNoteId: string | null;
}

const initial = (): LiveState => ({
  status: 'idle', mode: null, title: '', startedAt: 0, lines: [], partial: null, clarity: null,
  captionLang: getData().settings.myLang, room: null, notice: null, lastNoteId: null,
});

let state: LiveState = initial();
const listeners = new Set<() => void>();
let session: LiveSession | null = null;
let roomClient: RoomClient | null = null;
let cleanups: (() => void)[] = [];

function set(patch: Partial<LiveState>) {
  state = { ...state, ...patch };
  listeners.forEach(l => l());
}

export const getLive = (): LiveState => state;
export function subscribeLive(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function dismissNotice(): void { set({ notice: null }); }

async function askMicPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true; // iOS asks inside the native module
  const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
    title: 'Let Bibbly use the microphone', message: 'Bibbly listens to the conversation around you to caption and translate it.', buttonPositive: 'Allow',
  });
  return r === PermissionsAndroid.RESULTS.GRANTED;
}

/** Starts captioning with the phone's microphone or the demo meeting. */
export async function startLive(mode: 'mic' | 'demo'): Promise<void> {
  if (state.status !== 'idle') return;
  const s = getData().settings;
  const ai = claude();
  const demo = mode === 'demo';
  let provider = demo ? null : speechProvider();
  if (!demo && !provider) { set({ notice: NO_SPEECH_ENGINE }); return; }
  if (!demo && !micAvailable) { set({ notice: 'Live captions from the microphone need the Bibbly app build, not Expo Go. The demo meeting works here.' }); return; }
  if (!demo && !(await askMicPermission())) { set({ notice: 'Bibbly needs the microphone to caption. You can allow it in Settings.' }); return; }

  const me = { id: 'me', name: s.myName || 'You', self: true };
  const live = new LiveSession({
    title: demo ? DEMO_MEETING.title : 'Conversation', me, myLang: s.myLang, candidateLanguages: [...new Set([s.myLang, ...s.speaking])],
    glossary: s.glossary, autoClarityEvery: 6, source: demo ? 'Demo meeting' : 'Phone microphone',
  }, { translator: demo ? new DemoTranslator(ai) : ai, clarity: demo ? new DemoClarity(ai) : ai });
  session = live;
  set({ ...initial(), status: 'starting', mode, title: live.title, startedAt: live.startedAt,
        notice: !demo && !ai ? 'Captions work now; add a Claude API key in Settings for translations and notes.' : null });
  if (state.captionLang !== s.myLang) live.addTarget(state.captionLang);

  // The session fills in translations on the same line objects, so publish copies: React re-renders changed rows only.
  const upsert = (line: Line) => {
    const copy: Line = { ...line, tr: { ...line.tr } };
    const i = state.lines.findIndex(l => l.id === line.id);
    set({ lines: i < 0 ? [...state.lines, copy] : state.lines.map((l, j) => (j === i ? copy : l)) });
  };
  cleanups.push(
    live.on('line', upsert),
    live.on('translation', e => { const l = live.lines.find(x => x.id === e.lineId); if (l) upsert(l); }),
    live.on('partial', p => set({ partial: p.partial })),
    live.on('clarity', c => set({ clarity: c.clarity, title: c.title || state.title })),
    live.on('error', e => set({ notice: e.source === 'speech' ? e.message : describeClaudeError(e.cause ?? new Error(e.message)) })),
  );

  try {
    if (demo) {
      const script = DEMO_MEETING.lines.map(l => ({ at: l.t / 4.5, text: l.text, speakerId: l.speaker, lang: l.lang, ...(l.langs ? { langs: l.langs } : {}), confidence: l.confidence }));
      const speakers = Object.fromEntries(DEMO_MEETING.speakers.map(sp => [sp.id, sp.id === 'me' ? me : { id: `demo:${sp.id}`, name: sp.name }]));
      await live.attach('demo', new ScriptedSpeechProvider(script, { wordMs: 120 }), { diarize: true, speakers });
    } else {
      await live.attach('mic', provider!, { diarize: true });
      const frames = addFramesListener(e => live.write('mic', pcmFromBase64(e.pcm)));
      const errors = addErrorListener(e => set({ notice: e.message }));
      cleanups.push(() => frames.remove(), () => errors.remove());
      await startMic(16_000);
    }
    set({ status: 'live' });
  } catch (err) {
    provider = null;
    await teardown();
    set({ status: 'idle', notice: err instanceof Error ? err.message : 'Could not start listening.' });
  }
}

/** Joins a room shared from Bibbly desktop, with captions translated into your language. */
export function joinRoom(code: string): void {
  if (state.status !== 'idle') return;
  const s = getData().settings;
  const clean = code.trim().toLowerCase();
  if (!/^[a-z0-9]{4,12}$/.test(clean)) { set({ notice: 'Room codes are 4 to 12 letters and numbers.' }); return; }
  const url = s.roomServer.replace(/\/$/, '').replace(/^http/, 'ws') + '/ws';
  const client = new RoomClient(url, { room: clean, role: 'listener', name: s.myName || 'Guest', lang: state.captionLang });
  roomClient = client;
  const started = Date.now();
  const lines = new Map<string, Line>();
  const toLine = (w: WireLine): Line => ({
    id: w.id, t: w.t, speaker: { id: `room:${w.speaker}`, name: w.speaker }, channel: 'remote', text: w.text, lang: w.lang,
    ...(w.langs ? { langs: w.langs } : {}), ...(w.confidence != null ? { confidence: w.confidence } : {}), tr: lines.get(w.id)?.tr ?? {},
  });
  const publish = () => set({ lines: [...lines.values()].sort((a, b) => a.t - b.t) });
  set({ ...initial(), status: 'starting', mode: 'room', title: `Room ${clean}`, startedAt: started, room: { code: clean, members: [], connected: false } });
  cleanups.push(
    client.on('open', () => set({ status: 'live', room: { ...state.room!, connected: true } })),
    client.on('close', e => set({ room: state.room ? { ...state.room, connected: false } : null, ...(e.willRetry ? {} : { status: 'idle' }) })),
    client.on('message', m => {
      if (m.t === 'welcome') {
        for (const w of m.history) lines.set(w.id, toLine(w));
        // Translations already made for this listener's language, keyed by line id.
        for (const [id, text] of Object.entries(m.translations)) {
          const line = lines.get(id);
          if (line) lines.set(id, { ...line, tr: { ...line.tr, [state.captionLang]: text } });
        }
        set({ room: { code: clean, members: m.members, connected: true }, status: 'live' });
        publish();
      } else if (m.t === 'caption') { lines.set(m.line.id, toLine(m.line)); publish(); set({ partial: null }); }
      else if (m.t === 'translation') { const l = lines.get(m.id); if (l) { lines.set(m.id, { ...l, tr: { ...l.tr, [m.lang]: m.text } }); publish(); } }
      else if (m.t === 'partial') set({ partial: m.text ? { channel: 'remote', speaker: { id: `room:${m.speaker}`, name: m.speaker }, text: m.text, t: (Date.now() - started) / 1000, ...(m.lang ? { lang: m.lang } : {}) } : null });
      else if (m.t === 'members') set({ room: state.room ? { ...state.room, members: m.members } : null });
      else if (m.t === 'ended') { set({ notice: 'The host ended the meeting. The captions are saved in Notes.' }); void stopLive(); }
      else if (m.t === 'error') set({ notice: m.message });
    }),
  );
  client.connect();
}

/** Switches the caption language; in a room the server starts translating for you. */
export function setCaptionLang(lang: LangCode): void {
  const prev = state.captionLang;
  if (prev === lang) return;
  set({ captionLang: lang });
  roomClient?.setLang(lang);
  if (session && !session.ended) {
    const myLang = getData().settings.myLang;
    if (lang !== myLang) session.addTarget(lang);
    if (prev !== myLang) session.removeTarget(prev);
  }
}

async function teardown() {
  cleanups.forEach(c => c());
  cleanups = [];
  await stopMic().catch(() => {});
}

/** Stops and saves the conversation as a note. */
export async function stopLive(): Promise<Note | null> {
  if (state.status === 'idle' || state.status === 'stopping') return null;
  set({ status: 'stopping' });
  await stopMic().catch(() => {});
  let note: Note | null = null;
  if (session) {
    const live = session;
    session = null;
    await live.stop();
    if (live.lines.length) note = live.toNote();
  } else if (roomClient) {
    const lines = state.lines;
    roomClient.close();
    roomClient = null;
    if (lines.length) {
      const myLang = getData().settings.myLang;
      note = {
        id: uid('note-'), title: state.title, startedAt: state.startedAt, durationSec: Math.round((Date.now() - state.startedAt) / 1000),
        source: 'Bibbly room (listening)', platform: 'other', languages: [...new Set([...lines.map(l => l.lang || guessLang(l.text)), myLang])],
        speakers: [...new Map(lines.map(l => [l.speaker.id, l.speaker])).values()], lines, clarity: null, sentTo: [],
      };
    }
  }
  await teardown();
  if (note) saveNote(note);
  set({ ...initial(), lastNoteId: note?.id ?? null, notice: state.notice });
  return note;
}

/** Throws the conversation away. */
export async function discardLive(): Promise<void> {
  const live = session;
  session = null;
  roomClient?.close();
  roomClient = null;
  live?.dispose();
  await live?.stop({ summarize: false });
  await teardown();
  set(initial());
}

export async function refreshNotes(): Promise<void> { await session?.summarize(false); }
