import { useSyncExternalStore } from 'react';
import {
  hasTime, parseQuickTask, uid, type ActionItem, type CalendarEvent, type Channel, type Clarity, type ExportFormat, type FollowUp,
  type LangCode, type Line, type Member, type Note, type PartialLine, type Task,
} from '@bibbly/core';
import { api } from './api';
import { AudioCapture, findStickMic } from './audio/capture';
import type { AccountSettings, NoteTarget, ProviderId } from '@bibbly/connectors';
import type { AppData, ConnectorsView, SecretStatus, SessionEvent, Settings, StartOptions } from './shared/ipc';

export type Route = 'today' | 'live' | 'notes' | 'tasks' | 'calendar' | 'stick' | 'settings';
export const ROUTES: Route[] = ['today', 'live', 'notes', 'tasks', 'calendar', 'stick', 'settings'];

export interface LiveView {
  id: string;
  title: string;
  mode: 'demo' | 'live';
  startedAt: number;
  status: 'live' | 'stopping' | 'ended';
  lines: Line[];
  partials: Partial<Record<Channel, PartialLine | null>>;
  clarity: Clarity | null;
  clarityState: 'idle' | 'working' | 'error';
  clarityMessage?: string;
  /** Whose captions are shown: "me" or a language picked in "Captions for". */
  viewLang: LangCode;
  display: 'both' | 'tr' | 'orig';
  room: { code: string; joinUrl: string; members: Member[]; connected: boolean } | null;
  channels: StartOptions['channels'];
  warnings: string[];
  noteId?: string;
}

export interface Toast { id: number; text: string; action?: { label: string; run: () => void }; mascot?: 'happy' | 'idle' }

export interface State {
  data: AppData | null;
  secrets: SecretStatus | null;
  connectors: ConnectorsView | null;
  live: LiveView | null;
  route: Route;
  noteId: string | null;
  toast: Toast | null;
  levels: Partial<Record<Channel, number>>;
  error: string | null;
}

let state: State = {
  data: null, secrets: null, connectors: null, live: null, route: (ROUTES.find(r => `#${r}` === location.hash) ?? 'live'),
  noteId: null, toast: null, levels: {}, error: null,
};
const subs = new Set<() => void>();
export const getState = () => state;
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  subs.forEach(f => f());
}
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const useApp = () => useSyncExternalStore(subscribe, getState);

const setLive = (patch: Partial<LiveView> | ((l: LiveView) => Partial<LiveView>)) =>
  setState(s => (s.live ? { live: { ...s.live, ...(typeof patch === 'function' ? patch(s.live) : patch) } } : {}));

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string, opts: Omit<Toast, 'id' | 'text'> = {}) {
  clearTimeout(toastTimer);
  const t = { id: Date.now(), text, ...opts };
  setState({ toast: t });
  toastTimer = setTimeout(() => { if (getState().toast?.id === t.id) setState({ toast: null }); }, 5000);
}

export function go(route: Route, patch: Partial<State> = {}) {
  if (location.hash !== `#${route}`) history.replaceState(null, '', `#${route}`);
  setState({ route, ...patch });
}

/* ---------------------------------- boot --------------------------------- */
export async function init() {
  const [data, secrets] = await Promise.all([api.data.get(), api.secrets.status()]);
  setState({ data, secrets });
  api.onDataChanged(d => setState({ data: d }));
  api.connectors.onChanged(v => setState({ connectors: v }));
  api.connectors.onNotice(n => toast(n.text, n.url ? { action: { label: 'Open', run: () => void api.openExternal(n.url!) } } : {}));
  void api.connectors.view().then(v => setState({ connectors: v })).catch(() => undefined);
  api.session.onEvent(onSessionEvent);
  api.onNavigate?.(r => { if (ROUTES.includes(r as Route)) go(r as Route); });
}

function onSessionEvent(e: SessionEvent) {
  switch (e.type) {
    case 'line':
      setLive(l => {
        const i = l.lines.findIndex(x => x.id === e.line.id);
        const lines = i >= 0 ? l.lines.map(x => (x.id === e.line.id ? e.line : x)) : [...l.lines, e.line];
        return { lines };
      });
      break;
    case 'partial': setLive(l => ({ partials: { ...l.partials, [e.channel]: e.partial } })); break;
    case 'clarity': setLive({ clarity: e.clarity, title: e.title }); break;
    case 'clarityStatus': setLive({ clarityState: e.state, ...(e.message ? { clarityMessage: e.message } : {}) }); break;
    case 'error': toast(e.message); break;
    case 'ended': setLive({ status: 'ended', noteId: e.note.id, clarity: e.note.clarity, title: e.note.title }); break;
    case 'room': setLive(l => (l.room ? { room: { ...l.room, members: e.members, connected: e.connected } } : {})); break;
  }
}

/* --------------------------------- live ---------------------------------- */
let captures: AudioCapture[] = [];

export async function startSession(o: StartOptions) {
  const s = getState();
  if (!s.data) return;
  try {
    const res = await api.session.start(o);
    setState({
      live: {
        id: res.id, title: res.title, mode: o.mode, startedAt: res.startedAt, status: 'live', lines: [], partials: {}, clarity: null,
        clarityState: 'idle', viewLang: s.data.settings.myLang, display: 'both', room: res.room ? { ...res.room, members: [], connected: false } : null,
        channels: o.channels, warnings: res.warnings,
      },
    });
    res.warnings.forEach(w => toast(w));
    if (o.mode === 'live') await startCaptures(o.channels);
  } catch (err) {
    toast(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err));
  }
}

async function startCaptures(ch: StartOptions['channels']) {
  const make = (channel: Channel) => new AudioCapture(channel, pcm => api.session.frame(channel, pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer),
    level => setState(s => ({ levels: { ...s.levels, [channel]: level } })));
  const tries: Promise<void>[] = [];
  if (ch.mic) { const c = make('mic'); captures.push(c); tries.push(c.startMic()); }
  if (ch.system) { const c = make('system'); captures.push(c); tries.push(c.startSystem()); }
  if (ch.stick) {
    const id = await findStickMic();
    if (!id) toast('Plug in the Bibbly Stick to use it as a microphone.');
    else { const c = make('stick'); captures.push(c); tries.push(c.startMic(id)); }
  }
  const results = await Promise.allSettled(tries);
  for (const r of results) if (r.status === 'rejected') toast(r.reason instanceof Error ? r.reason.message : 'An audio source could not start.');
}

async function stopCaptures() {
  const cs = captures;
  captures = [];
  await Promise.all(cs.map(c => c.stop()));
  setState({ levels: {} });
}

export async function stopSession() {
  setLive({ status: 'stopping' });
  await stopCaptures();
  const note = await api.session.stop();
  if (!note) { setState({ live: null }); toast('Nothing was said, so there is nothing to save.'); return; }
  setLive({ status: 'ended', noteId: note.id, clarity: note.clarity, title: note.title });
  toast('Saved to Notes.', { mascot: 'happy', action: { label: 'Open', run: () => go('notes', { noteId: note.id }) } });
}

export async function discardSession() {
  await stopCaptures();
  await api.session.discard();
  setState({ live: null });
}

export function closeLive() { setState({ live: null }); }

/** "Captions for": show the captions as someone reading another language sees them. */
export async function setViewLang(lang: LangCode) {
  const l = getState().live;
  const mine = getState().data?.settings.myLang;
  if (!l) return;
  if (l.viewLang !== mine) await api.session.watchLanguage(l.viewLang, false);
  if (lang !== mine) await api.session.watchLanguage(lang, true);
  setLive({ viewLang: lang });
  if (lang !== mine) void api.session.translateNotes(lang);
}

/* --------------------------------- data ---------------------------------- */
const data = () => getState().data!;
function patchData(p: Partial<AppData>) { setState(s => ({ data: s.data ? { ...s.data, ...p } : s.data })); }

export async function saveSettings(p: Partial<Settings>) {
  const settings = { ...data().settings, ...p };
  patchData({ settings });
  await api.data.saveSettings(settings);
}

function saveTasks(tasks: Task[]) { patchData({ tasks }); void api.data.saveTasks(tasks); }

export function addTask(text: string): Task | null {
  const raw = text.trim();
  if (!raw) return null;
  const q = parseQuickTask(raw);
  const t: Task = { id: uid('t_'), title: q.title, due: q.due, remind: q.remind, list: q.list, done: false, updatedAt: Date.now() };
  saveTasks([t, ...data().tasks]);
  // Text in other scripts ("明天下午三点给李伟发报价") is tidied by Claude when a key is set.
  if (/[^\u0000-ɏ\s]/.test(raw)) {
    void api.tasks.refine(raw).then(r => { if (r) updateTask(t.id, { ...r }); }).catch(() => undefined);
  }
  return t;
}
/** Every change stamps updatedAt, so sync can tell which side changed last. */
export function updateTask(id: string, p: Partial<Task>) { saveTasks(data().tasks.map(t => (t.id === id ? { ...t, ...p, updatedAt: Date.now() } : t))); }
export function deleteTask(id: string) { saveTasks(data().tasks.filter(t => t.id !== id)); }
export function toggleTask(id: string) {
  const t = data().tasks.find(x => x.id === id);
  if (!t) return;
  updateTask(id, { done: !t.done, doneAt: t.done ? null : Date.now() });
  if (!t.done) toast(`Done: ${t.title}`, { mascot: 'happy', action: { label: 'Undo', run: () => updateTask(id, { done: false, doneAt: null }) } });
}

export function addActionAsTask(a: ActionItem, note: Pick<Note, 'id'>, lang: LangCode) {
  if (data().tasks.some(t => t.source?.actionId === a.id)) { toast('Already in your tasks.'); return; }
  const text = a.text[lang] ?? a.text[a.src] ?? '';
  const title = a.ownerIsMe ? text : `Follow up with ${a.owner}: ${text}`;
  saveTasks([{ id: uid('t_'), title, list: 'Work', due: a.due, remind: !!a.due && hasTime(a.due), done: false, updatedAt: Date.now(),
               source: { noteId: note.id, ...(a.lineId ? { lineId: a.lineId } : {}), actionId: a.id } }, ...data().tasks]);
  toast('Added to Tasks.', { mascot: 'happy', action: { label: 'View', run: () => go('tasks') } });
}

export function saveEvents(events: CalendarEvent[]) { patchData({ events }); void api.data.saveEvents(events); }
export function updateEvent(id: string, p: Partial<CalendarEvent>) { saveEvents(data().events.map(e => (e.id === id ? { ...e, ...p, updatedAt: Date.now() } : e))); }

export function addFollowUp(f: FollowUp, note: Pick<Note, 'id' | 'languages'>, lang: LangCode) {
  const title = f.text[lang] ?? f.text[f.src] ?? 'Follow-up';
  const start = f.when ?? Date.now() + 86_400_000;
  if (data().events.some(e => e.prevNoteId === note.id && e.title === title)) { toast('It’s already on your calendar.'); return; }
  saveEvents([...data().events, { id: uid('e_'), title, start, durationMin: f.durationMin, platform: 'zoom', languages: note.languages, bibblyJoins: true, prevNoteId: note.id, updatedAt: Date.now() }]);
  toast('Added to your calendar.', { action: { label: 'View', run: () => go('calendar') } });
}

export async function deleteNote(id: string) {
  patchData({ notes: data().notes.filter(n => n.id !== id) });
  await api.data.deleteNote(id);
  setState({ noteId: null });
}

export async function translateNote(id: string, lang: LangCode) {
  try {
    const note = await api.notes.translate(id, lang);
    patchData({ notes: data().notes.map(n => (n.id === id ? note : n)) });
  } catch (err) { toast(err instanceof Error ? err.message : 'Translation failed.'); }
}

export async function exportNote(id: string, format: ExportFormat, lang: LangCode, opts: { original: boolean; clarity: boolean }) {
  try {
    const r = await api.notes.export(id, format, lang, opts);
    if (r.saved) toast(`Saved ${r.path?.split(/[\\/]/).pop() ?? 'file'}.`, { mascot: 'happy' });
  } catch (err) { toast(err instanceof Error ? err.message : 'That export did not work.'); }
}

/* ---------------------------- connected apps ----------------------------- */
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');

export async function connectApp(provider: ProviderId, token?: string) {
  try { setState({ connectors: await api.connectors.connect(provider, token) }); }
  catch (err) { const m = errText(err); if (!/cancelled/i.test(m)) toast(m); }
}
export async function cancelConnect() { await api.connectors.cancelConnect(); }
export async function disconnectApp(accountId: string) {
  try { setState({ connectors: await api.connectors.disconnect(accountId) }); toast('Disconnected. Bibbly’s copies of its events were removed; your tasks stay.'); }
  catch (err) { toast(errText(err)); }
}
export async function updateAccountSettings(accountId: string, settings: AccountSettings) {
  try { setState({ connectors: await api.connectors.updateSettings(accountId, settings) }); }
  catch (err) { toast(errText(err)); }
}
export async function syncNow() {
  try { setState({ connectors: await api.connectors.syncNow() }); }
  catch (err) { toast(errText(err)); }
}
export async function refreshConnectors() {
  try { setState({ connectors: await api.connectors.view() }); } catch { /* keep the last view */ }
}
export async function noteTargets(accountId: string): Promise<NoteTarget[]> {
  try { return await api.connectors.targets(accountId); }
  catch (err) { toast(errText(err)); return []; }
}
export async function publishNote(noteId: string, accountId: string, target: NoteTarget | null, lang: LangCode): Promise<boolean> {
  try {
    const copy = await api.connectors.publish(noteId, accountId, target, lang);
    toast(`Sent to ${copy.target}.`, { mascot: 'happy', ...(copy.url ? { action: { label: 'Open', run: () => void api.openExternal(copy.url!) } } : {}) });
    return true;
  } catch (err) { toast(errText(err)); return false; }
}
