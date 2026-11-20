import fs from 'node:fs';
import path from 'node:path';
import {
  app, BrowserWindow, desktopCapturer, dialog, ipcMain, Notification, screen, session, shell, type IpcMainInvokeEvent,
} from 'electron';
import {
  buildExport, decodeWav, DemoTranslator, lineText, type CalendarEvent, type Channel, type ExportFormat, type LangCode, type Note, type Task,
} from '@bibbly/core';
import type { AccountSettings, NoteTarget, ProviderId } from '@bibbly/connectors';
import type { AppData, ConnectorNotice, ImportMeta, SecretName, SessionEvent, Settings, StartOptions } from '../src/shared/ipc.js';
import { ConnectorService } from './connectors.js';
import { SessionManager } from './engine.js';
import { Secrets } from './secrets.js';
import { seedData } from './seed.js';
import { StickSimulator } from './simulator.js';
import { DataStore } from './store.js';

/** USB ids of the Bibbly Stick firmware. 0x1209/0x0001 is the pid.codes test pair: replace before shipping hardware. */
const STICK_USB = { vendorId: 0x1209, productId: 0x0001 };

if (process.env.BIBBLY_USER_DATA) app.setPath('userData', process.env.BIBBLY_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();

let mainWin: BrowserWindow | null = null;
let miniWin: BrowserWindow | null = null;
const rendererIndex = path.join(__dirname, '../dist/index.html');

function load(win: BrowserWindow, hash = '') {
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) void win.loadURL(`${dev}${hash ? `#${hash}` : ''}`);
  else void win.loadFile(rendererIndex, hash ? { hash } : undefined);
}

function secure(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://') && !url.startsWith(process.env.VITE_DEV_SERVER_URL ?? '\u0000')) e.preventDefault(); });
}

const prefs = { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false };

function createMain() {
  mainWin = new BrowserWindow({ width: 1320, height: 860, minWidth: 380, minHeight: 560, title: 'Bibbly', backgroundColor: '#EDF4F1', show: false, webPreferences: prefs });
  secure(mainWin);
  mainWin.once('ready-to-show', () => mainWin?.show());
  mainWin.on('closed', () => { mainWin = null; miniWin?.close(); });
  load(mainWin);
}

function toggleMini(show?: boolean): boolean {
  if (miniWin && show !== true) { miniWin.close(); miniWin = null; return false; }
  if (miniWin) return true;
  const area = screen.getPrimaryDisplay().workArea;
  miniWin = new BrowserWindow({
    width: 440, height: 170, x: area.x + area.width - 460, y: area.y + area.height - 200, frame: false, transparent: true, resizable: true,
    alwaysOnTop: true, skipTaskbar: true, title: 'Bibbly Mini', webPreferences: prefs,
  });
  miniWin.setAlwaysOnTop(true, 'floating');
  miniWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  secure(miniWin);
  miniWin.on('closed', () => { miniWin = null; });
  load(miniWin, 'mini');
  return true;
}

const broadcast = (channel: string, payload: unknown) => {
  for (const w of [mainWin, miniWin]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
};

async function translateNote(manager: SessionManager, store: DataStore, note: Note, lang: LangCode): Promise<Note> {
  const translator = new DemoTranslator(manager.claude());
  const missing = note.lines.filter(l => lineText(l, lang).missing);
  for (let i = 0; i < missing.length; i += 12) {
    const batch = missing.slice(i, i + 12);
    try {
      const res = await translator.translate({ target: lang, title: note.title, items: batch.map(l => ({ id: l.id, text: l.text, speaker: l.speaker.name })) });
      for (const r of res) { const l = note.lines.find(x => x.id === r.id); if (l) l.tr[lang] = r.translation; }
    } catch { break; }
  }
  const c = note.clarity;
  if (c) {
    const items = [...c.summary, ...c.decisions, ...c.actions, ...(c.followup ? [c.followup] : [])].filter(it => !it.text[lang]);
    if (items.length) {
      try {
        const res = await translator.translate({ target: lang, title: note.title, items: items.map((it, i) => ({ id: String(i), text: it.text[it.src] ?? '' })) });
        for (const r of res) { const it = items[Number(r.id)]; if (it) it.text[lang] = r.translation; }
      } catch { /* keep what we have */ }
    }
  }
  store.update({ notes: store.data.notes.map(n => (n.id === note.id ? note : n)) });
  return note;
}

app.whenReady().then(async () => {
  const dir = app.getPath('userData');
  const store = new DataStore(dir);
  await store.load(() => seedData(app.getLocale()));
  const secrets = new Secrets(dir);
  const manager = new SessionManager(store, secrets, (e: SessionEvent) => broadcast('session:event', e));
  const simulator = new StickSimulator(bytes => mainWin?.webContents.send('stick:sim:data', bytes));
  const dataChanged = () => broadcast('data:changed', store.data);
  const connectors = new ConnectorService({
    dir, store, serverUrl: () => store.data.settings.roomServer,
    onChange: v => broadcast('connectors:changed', v),
    onData: dataChanged,
    notify: (n: ConnectorNotice) => broadcast('connectors:notice', n),
  });

  // Permissions: microphone, meeting audio, notifications and the Bibbly Stick only.
  const allowed = new Set(['media', 'display-capture', 'notifications', 'clipboard-sanitized-write', 'usb', 'hid']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  session.defaultSession.setDevicePermissionHandler(d => {
    const dev = d.device as { vendorId?: number; productId?: number };
    return dev.vendorId === STICK_USB.vendorId && dev.productId === STICK_USB.productId;
  });
  session.defaultSession.on('select-usb-device', (event, details, cb) => {
    event.preventDefault();
    cb(details.deviceList.find(d => d.vendorId === STICK_USB.vendorId && d.productId === STICK_USB.productId)?.deviceId);
  });
  session.defaultSession.on('select-hid-device', (event, details, cb) => {
    event.preventDefault();
    cb(details.deviceList.find(d => d.vendorId === STICK_USB.vendorId && d.productId === STICK_USB.productId)?.deviceId);
  });
  // Meeting audio: the system's own output, captured as a loopback stream (Windows, macOS 13+).
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    cb(sources[0] ? { video: sources[0], audio: 'loopback' } : {});
  });

  const h = <A extends unknown[], R>(channel: string, fn: (...args: A) => R) =>
    ipcMain.handle(channel, (_e: IpcMainInvokeEvent, ...args: unknown[]) => fn(...(args as A)));

  h('data:get', (): AppData => store.data);
  h('data:saveTasks', (tasks: Task[]) => { store.update({ tasks }); connectors.scheduleSync(); });
  h('data:saveEvents', (events: CalendarEvent[]) => { store.update({ events }); connectors.scheduleSync(); });
  h('data:saveNote', (note: Note) => { store.update({ notes: [note, ...store.data.notes.filter(n => n.id !== note.id)] }); });
  h('data:deleteNote', (id: string) => {
    const note = store.data.notes.find(n => n.id === id);
    if (note?.audioFile) fs.rmSync(note.audioFile, { force: true });
    store.update({ notes: store.data.notes.filter(n => n.id !== id) });
  });
  h('data:saveSettings', (s: Settings) => { store.update({ settings: s }); dataChanged(); });
  h('secrets:status', () => secrets.status());
  h('secrets:set', (name: SecretName, value: string | null) => { secrets.set(name, value); return secrets.status(); });

  h('session:start', (o: StartOptions) => manager.start(o));
  ipcMain.on('session:frame', (_e, channel: Channel, pcm: ArrayBuffer) => manager.frame(channel, pcm));
  h('session:stop', async () => {
    const note = await manager.stop();
    dataChanged();
    if (note) void connectors.autoPublish(note);
    return note;
  });
  h('session:discard', () => manager.discard());
  h('session:summarize', () => manager.summarize());
  h('session:snapshot', () => manager.snapshot());
  h('session:retry', (lineId: string, lang: LangCode) => manager.retry(lineId, lang));
  h('session:watch', (lang: LangCode, on: boolean) => manager.watch(lang, on));
  h('session:translateNotes', (lang: LangCode) => manager.translateNotes(lang));

  h('notes:translate', async (id: string, lang: LangCode) => {
    const note = store.data.notes.find(n => n.id === id);
    if (!note) throw new Error('That note no longer exists.');
    return translateNote(manager, store, note, lang);
  });
  h('notes:export', async (id: string, format: ExportFormat, lang: LangCode, opts: { original: boolean; clarity: boolean }) => {
    let note = store.data.notes.find(n => n.id === id);
    if (!note) throw new Error('That note no longer exists.');
    if (note.lines.some(l => lineText(l, lang).missing)) note = await translateNote(manager, store, note, lang);
    const file = buildExport(note, format, lang, { ...opts, myName: store.data.settings.myName });
    const auto = process.env.BIBBLY_EXPORT_DIR;
    let target: string | undefined;
    if (auto) target = path.join(auto, file.filename);
    else {
      const res = await dialog.showSaveDialog(mainWin!, { defaultPath: path.join(app.getPath('documents'), file.filename) });
      target = res.canceled ? undefined : res.filePath;
    }
    if (!target) return { saved: false };
    fs.writeFileSync(target, file.data);
    return { saved: true, path: target };
  });
  h('tasks:refine', async (text: string) => manager.claude()?.refine(text, Date.now()) ?? null);

  h('stick:import', async (wav: ArrayBuffer, meta: ImportMeta) => {
    const bytes = new Uint8Array(wav);
    const decoded = decodeWav(bytes);
    const recDir = path.join(dir, 'recordings');
    fs.mkdirSync(recDir, { recursive: true });
    const audioFile = path.join(recDir, `stick-${meta.startedAt || Date.now()}.wav`);
    fs.writeFileSync(audioFile, bytes);
    let note: Note;
    try {
      note = await manager.importRecording(decoded, meta);
      note.audioFile = audioFile;
    } catch (err) {
      note = { id: `stick-${Date.now()}`, title: meta.title ?? 'Bibbly Stick recording', startedAt: meta.startedAt || Date.now(), durationSec: Math.round(meta.durationMs / 1000),
               source: 'Bibbly Stick (offline recording)', languages: [], speakers: [], lines: [], clarity: null, sentTo: [], audioFile,
               pendingReason: err instanceof Error ? err.message : String(err) };
    }
    store.update({ notes: [note, ...store.data.notes.filter(n => n.id !== note.id)] });
    dataChanged();
    return note;
  });
  h('stick:sim:available', () => simulator.available());
  h('stick:sim:start', () => simulator.start());
  h('stick:sim:stop', () => simulator.stop());
  ipcMain.on('stick:sim:write', (_e, bytes: Uint8Array) => simulator.write(bytes));

  h('connectors:view', async () => { await connectors.checkServer(); return connectors.view(); });
  h('connectors:connect', (provider: ProviderId, token?: string) => connectors.connect(provider, token));
  h('connectors:cancel', () => connectors.cancelConnect());
  h('connectors:disconnect', (id: string) => connectors.disconnect(id));
  h('connectors:settings', (id: string, settings: AccountSettings) => connectors.updateSettings(id, settings));
  h('connectors:targets', (id: string) => connectors.targets(id));
  h('connectors:sync', async () => { await connectors.syncNow(); return connectors.view(); });
  h('connectors:publish', (noteId: string, accountId: string, target: NoteTarget | null, lang: LangCode) => connectors.publish(noteId, accountId, target, lang));

  h('mini:toggle', (show?: boolean) => toggleMini(show));
  h('app:openExternal', (url: string) => { if (/^https?:\/\//.test(url)) return shell.openExternal(url); });

  // Reminders: a notification when a task with a reminder comes due.
  const notified = new Set<string>();
  setInterval(() => {
    const now = Date.now();
    for (const t of store.data.tasks) {
      if (!t.remind || t.done || !t.due || notified.has(t.id) || t.due > now || now - t.due > 15 * 60_000) continue;
      notified.add(t.id);
      if (Notification.isSupported()) {
        const n = new Notification({ title: 'Bibbly reminder', body: t.title, silent: false });
        n.on('click', () => { mainWin?.show(); mainWin?.webContents.send('app:navigate', 'tasks'); });
        n.show();
      }
    }
  }, 30_000);

  createMain();
  connectors.start();
  app.on('second-instance', () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } });
  app.on('activate', () => { if (!mainWin) createMain(); });
  app.on('before-quit', () => { connectors.stop(); store.saveNow(); simulator.stop(); void manager.discard(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
