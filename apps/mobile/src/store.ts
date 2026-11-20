/**
 * The phone's saved data (notes, tasks, calendar events from connected apps,
 * settings) in one object, persisted to AsyncStorage. API keys and sign-ins
 * never go here: see secrets.ts and connectors.ts.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_CLAUDE_MODEL } from '@bibbly/core/claude';
import { addDays, atTime, startOfDay, type CalendarEvent, type LangCode, type Note, type Task } from '@bibbly/core';
import { useSyncExternalStore } from 'react';
import { getLocales } from 'expo-localization';

export type EngineId = 'demo' | 'whisper';

export interface Settings {
  myName: string;
  /** Language Bibbly shows captions and notes in. */
  myLang: LangCode;
  /** Languages people around you speak (hints for the speech engine). */
  speaking: LangCode[];
  engine: EngineId;
  whisperUrl: string;
  claudeModel: string;
  /** Bibbly server (apps/server): rooms, and sign-in for connected apps. */
  roomServer: string;
  glossary: string[];
}

export interface AppData {
  version: 1;
  notes: Note[];
  tasks: Task[];
  /** Meetings from connected calendars, and follow-ups saved to them. */
  events: CalendarEvent[];
  settings: Settings;
}

const KEY = 'bibbly-data-v1';

export const DEFAULT_SETTINGS: Settings = {
  myName: 'You',
  myLang: 'en',
  speaking: ['en', 'zh', 'ja'],
  engine: 'demo',
  whisperUrl: 'https://api.openai.com',
  claudeModel: DEFAULT_CLAUDE_MODEL,
  roomServer: 'http://192.168.1.10:8787',
  glossary: ['Bibbly'],
};

function firstRun(): AppData {
  const today = startOfDay(Date.now());
  const code = getLocales()[0]?.languageCode ?? 'en';
  const myLang = code === 'zh' ? 'zh' : code === 'ja' ? 'ja' : code === 'ko' ? 'ko' : 'en';
  const tasks: Task[] = [
    { id: 'welcome-1', title: 'Try the demo meeting on the Live tab', list: 'Personal', due: null, remind: false, done: false },
    { id: 'welcome-2', title: 'Add your Claude API key in Settings for translations', list: 'Personal', due: atTime(addDays(today, 1), '10:00').getTime(), remind: false, done: false },
  ];
  return { version: 1, notes: [], tasks, events: [], settings: { ...DEFAULT_SETTINGS, myLang } };
}

let data: AppData = firstRun();
let ready = false;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

export async function hydrate(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AppData;
      if (parsed?.version === 1) data = { ...parsed, events: parsed.events ?? [], settings: { ...DEFAULT_SETTINGS, ...parsed.settings } };
    }
  } catch (err) {
    console.warn('[bibbly] could not read saved data, starting fresh', err);
  }
  ready = true;
  emit();
}

function emit() { listeners.forEach(l => l()); }

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export const getData = (): AppData => data;
/** Called after every change (connected-app sync uses it to notice task edits). */
export const onDataChange = (cb: () => void): (() => void) => subscribe(cb);
export const isReady = (): boolean => ready;

export function update(patch: Partial<AppData> | ((d: AppData) => Partial<AppData>)): void {
  data = { ...data, ...(typeof patch === 'function' ? patch(data) : patch) };
  emit();
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { AsyncStorage.setItem(KEY, JSON.stringify(data)).catch(err => console.warn('[bibbly] save failed', err)); }, 300);
}

export function updateSettings(patch: Partial<Settings>): void {
  update(d => ({ settings: { ...d.settings, ...patch } }));
}

export function saveNote(note: Note): void {
  update(d => ({ notes: [note, ...d.notes.filter(n => n.id !== note.id)] }));
}

/** Subscribes a component to a slice of the data. Selectors must return stable references (slices, not new objects). */
export function useData<T>(select: (d: AppData) => T): T {
  return useSyncExternalStore(subscribe, () => select(data), () => select(data));
}

export function useReady(): boolean {
  return useSyncExternalStore(subscribe, () => ready, () => ready);
}
