import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AppData, BibblyApi, SessionEvent } from '../src/shared/ipc.js';

const on = <T>(channel: string, cb: (payload: T) => void) => {
  const fn = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => { ipcRenderer.removeListener(channel, fn); };
};

const api: BibblyApi & { onNavigate(cb: (route: string) => void): () => void } = {
  platform: process.platform,
  data: {
    get: () => ipcRenderer.invoke('data:get'),
    saveTasks: tasks => ipcRenderer.invoke('data:saveTasks', tasks),
    saveEvents: events => ipcRenderer.invoke('data:saveEvents', events),
    saveNote: note => ipcRenderer.invoke('data:saveNote', note),
    deleteNote: id => ipcRenderer.invoke('data:deleteNote', id),
    saveSettings: s => ipcRenderer.invoke('data:saveSettings', s),
  },
  secrets: {
    status: () => ipcRenderer.invoke('secrets:status'),
    set: (name, value) => ipcRenderer.invoke('secrets:set', name, value),
  },
  session: {
    start: o => ipcRenderer.invoke('session:start', o),
    frame: (channel, pcm) => ipcRenderer.send('session:frame', channel, pcm),
    stop: () => ipcRenderer.invoke('session:stop'),
    discard: () => ipcRenderer.invoke('session:discard'),
    summarize: () => ipcRenderer.invoke('session:summarize'),
    retry: (lineId, lang) => ipcRenderer.invoke('session:retry', lineId, lang),
    watchLanguage: (lang, onOff) => ipcRenderer.invoke('session:watch', lang, onOff),
    translateNotes: lang => ipcRenderer.invoke('session:translateNotes', lang),
    onEvent: cb => on<SessionEvent>('session:event', cb),
    snapshot: () => ipcRenderer.invoke('session:snapshot'),
  },
  notes: {
    export: (id, format, lang, opts) => ipcRenderer.invoke('notes:export', id, format, lang, opts),
    translate: (id, lang) => ipcRenderer.invoke('notes:translate', id, lang),
  },
  tasks: { refine: text => ipcRenderer.invoke('tasks:refine', text) },
  stick: {
    importRecording: (wav, meta) => ipcRenderer.invoke('stick:import', wav, meta),
    simulatorAvailable: () => ipcRenderer.invoke('stick:sim:available'),
    simulatorStart: () => ipcRenderer.invoke('stick:sim:start'),
    simulatorStop: () => ipcRenderer.invoke('stick:sim:stop'),
    simulatorWrite: bytes => ipcRenderer.send('stick:sim:write', bytes),
    onSimulatorData: cb => on<Uint8Array>('stick:sim:data', cb),
  },
  mini: { toggle: show => ipcRenderer.invoke('mini:toggle', show) },
  openExternal: url => ipcRenderer.invoke('app:openExternal', url),
  onDataChanged: cb => on<AppData>('data:changed', cb),
  onNavigate: cb => on<string>('app:navigate', cb),
};

contextBridge.exposeInMainWorld('bibbly', api);
