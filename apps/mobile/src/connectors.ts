/**
 * Connected apps on the phone: sign-in through the Bibbly server's broker (the
 * apps' client secrets stay on the server), tokens in the keychain, two-way
 * sync of tasks and calendar while Bibbly is open, and sending notes to Google
 * Docs, Teams, Slack, Notion and Lark.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BrokerClient, ConnectorError, Connectors, PROVIDERS, applySyncResult, completionCode, emptyConnectorState, endpointsAt, hash,
  type AccountSettings, type BrokerProvider, type ConnectMethod, type ConnectedAccount, type ConnectorState, type NoteTarget,
  type ProviderId, type TokenSet, type TokenStore,
} from '@bibbly/connectors';
import type { LangCode, Note, SharedCopy } from '@bibbly/core';
import * as Linking from 'expo-linking';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { getData, onDataChange, update } from './store';

const STATE_KEY = 'bibbly-connectors-v1';
const SYNC_EVERY_MS = 5 * 60_000;

/* ------------------------------ tokens ------------------------------ */

/** The browser preview has no keychain: sign-ins then last for the session only. */
const keychain = Platform.OS !== 'web';
const CHUNK = 1800; // SecureStore warns above 2 KB per value on Android
const keyOf = (accountId: string) => `bibbly.tokens.${hash(accountId)}`;
const cache = new Map<string, TokenSet | null>();

const tokens: TokenStore = {
  async get(id) {
    if (cache.has(id)) return cache.get(id) ?? null;
    if (!keychain) return null;
    const base = keyOf(id);
    const n = Number((await SecureStore.getItemAsync(`${base}.n`)) ?? 0);
    let raw = '';
    for (let i = 0; i < n; i++) raw += (await SecureStore.getItemAsync(`${base}.${i}`)) ?? '';
    let t: TokenSet | null = null;
    try { t = raw ? (JSON.parse(raw) as TokenSet) : null; } catch { t = null; }
    cache.set(id, t);
    return t;
  },
  async set(id, t) {
    cache.set(id, t);
    if (!keychain) return;
    const base = keyOf(id);
    const old = Number((await SecureStore.getItemAsync(`${base}.n`)) ?? 0);
    const raw = t ? JSON.stringify(t) : '';
    const parts = Math.ceil(raw.length / CHUNK);
    for (let i = 0; i < parts; i++) await SecureStore.setItemAsync(`${base}.${i}`, raw.slice(i * CHUNK, (i + 1) * CHUNK));
    for (let i = parts; i < old; i++) await SecureStore.deleteItemAsync(`${base}.${i}`);
    if (parts) await SecureStore.setItemAsync(`${base}.n`, String(parts));
    else await SecureStore.deleteItemAsync(`${base}.n`);
  },
};

/* ------------------------------ state ------------------------------- */

export interface ConnectorsView {
  state: ConnectorState;
  /** What the Bibbly server can connect; null when it couldn't be reached. */
  server: BrokerProvider[] | null;
  serverError?: string;
  syncing: boolean;
  connecting: ProviderId | null;
}

let view: ConnectorsView = { state: emptyConnectorState(), server: null, syncing: false, connecting: null };
const listeners = new Set<() => void>();
function set(patch: Partial<ConnectorsView>) {
  view = { ...view, ...patch };
  listeners.forEach(l => l());
}
function setState(state: ConnectorState) {
  set({ state });
  AsyncStorage.setItem(STATE_KEY, JSON.stringify(state)).catch(err => console.warn('[bibbly] could not save connected apps', err));
}
export const getConnectors = () => view;
export function useConnectors(): ConnectorsView {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => view, () => view);
}

const broker = () => new BrokerClient(getData().settings.roomServer);
/** Test builds send every provider call to one fake server (set at build time; see e2e/preview.mjs). */
const providerBase = process.env.EXPO_PUBLIC_BIBBLY_PROVIDER_BASE_URL;
const connectors = new Connectors({
  tokens, refresh: (account, rt) => broker().refresh(account.provider, rt), ...(providerBase ? { endpoints: endpointsAt(providerBase) } : {}),
});

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Asks the Bibbly server which apps it can connect. */
export async function checkServer(): Promise<void> {
  try { set({ server: await broker().providers(), serverError: undefined }); }
  catch (err) { set({ server: null, serverError: message(err) }); }
}

export const canSignIn = (v: ConnectorsView, p: ProviderId) => !!v.server?.some(x => x.id === p && x.configured);

/**
 * Connects an account: the system browser signs in through the Bibbly server
 * and returns to bibbly://oauth; or a pasted Slack or Notion token.
 * Resolves null when the user closes the browser.
 */
export async function connect(provider: ProviderId, token?: string): Promise<ConnectedAccount | null> {
  set({ connecting: provider });
  try {
    let t: TokenSet;
    let method: ConnectMethod;
    if (token?.trim()) {
      t = { accessToken: token.trim() };
      method = 'token';
    } else {
      const b = broker();
      const redirect = Linking.createURL('oauth');
      const s = await b.start(provider, redirect);
      const res = await WebBrowser.openAuthSessionAsync(s.authorizeUrl, redirect);
      if (res.type !== 'success') return null;
      t = await b.collect(s, completionCode(res.url, s));
      method = 'broker';
    }
    const r = await connectors.addAccount(view.state, provider, method, t);
    setState(r.state);
    void syncNow();
    return r.account;
  } finally {
    set({ connecting: null });
  }
}

export async function disconnect(accountId: string): Promise<void> {
  await running;
  const d = getData();
  const r = await connectors.removeAccount(view.state, accountId, { tasks: d.tasks, events: d.events });
  setState(r.state);
  applying = true;
  try { update(r.data); } finally { applying = false; }
}

export function updateAccountSettings(accountId: string, settings: AccountSettings): void {
  setState(connectors.updateSettings(view.state, accountId, settings));
  scheduleSync(500);
}

export async function noteTargets(accountId: string): Promise<NoteTarget[]> {
  const account = view.state.accounts.find(a => a.id === accountId);
  const api = account ? connectors.notes(account) : null;
  return api ? api.listTargets() : [];
}

/* ------------------------------ sync -------------------------------- */

/** The welcome tasks stay on the phone. */
const isWelcome = (t: { id: string }) => t.id.startsWith('welcome-');
const syncs = () => view.state.accounts.some(a => a.settings.calendar?.enabled || a.settings.tasks?.enabled);

let running: Promise<void> | null = null;
let again = false;
let applying = false;
let soon: ReturnType<typeof setTimeout> | null = null;

export function syncNow(): Promise<void> {
  if (running) { again = true; return running; }
  if (!syncs()) return Promise.resolve();
  set({ syncing: true });
  running = (async () => {
    do {
      again = false;
      const d = getData();
      const before = { tasks: d.tasks.filter(t => !isWelcome(t)), events: d.events };
      const r = await connectors.syncAll(view.state, before);
      setState(r.state);
      const cur = getData();
      const merged = applySyncResult(before, r.data, { tasks: cur.tasks.filter(t => !isWelcome(t)), events: cur.events });
      applying = true;
      try { update({ tasks: [...cur.tasks.filter(isWelcome), ...merged.tasks], events: merged.events }); } finally { applying = false; }
    } while (again);
  })()
    .catch(err => console.warn('[bibbly] sync stopped', err))
    .finally(() => { running = null; set({ syncing: false }); });
  return running;
}

export function scheduleSync(delayMs = 8000): void {
  if (!syncs()) return;
  if (soon) clearTimeout(soon);
  soon = setTimeout(() => { soon = null; void syncNow(); }, delayMs);
}

let started = false;

/** Loads connected accounts and syncs: at launch, when the app comes back, every few minutes, and after you change a task. */
export async function startConnectors(): Promise<void> {
  if (started) return;
  started = true;
  try {
    const raw = await AsyncStorage.getItem(STATE_KEY);
    const saved = raw ? (JSON.parse(raw) as ConnectorState) : null;
    if (saved?.version === 1) set({ state: saved });
  } catch (err) { console.warn('[bibbly] could not read connected apps', err); }
  let last = getData();
  onDataChange(() => {
    const d = getData();
    if (d.tasks === last.tasks && d.events === last.events) return;
    last = d;
    if (!applying) scheduleSync();
  });
  AppState.addEventListener('change', s => { if (s === 'active') scheduleSync(1000); });
  setInterval(() => { if (AppState.currentState === 'active') void syncNow(); }, SYNC_EVERY_MS);
  void checkServer();
  scheduleSync(1500);
}

/* ------------------------------ notes ------------------------------- */

export async function publish(note: Note, accountId: string, target: NoteTarget | null, lang: LangCode): Promise<SharedCopy> {
  const account = view.state.accounts.find(a => a.id === accountId);
  if (!account) throw new Error('That account is no longer connected.');
  const copy = await connectors.publish(account, note, { lang, myName: getData().settings.myName }, target ?? undefined);
  const name = PROVIDERS[account.provider].name;
  update(d => ({ notes: d.notes.map(n => (n.id === note.id ? { ...n, shared: [...(n.shared ?? []), copy], sentTo: [...new Set([...n.sentTo, name])] } : n)) }));
  return copy;
}

/** After a session: sends the note everywhere "Send every note" is on. Returns what to tell the user. */
export async function autoPublish(note: Note): Promise<string | null> {
  const lines: string[] = [];
  for (const a of view.state.accounts) {
    const n = a.settings.notes;
    if (!n?.enabled || !n.auto || (!n.target && a.provider !== 'google')) continue;
    try {
      const copy = await publish(note, a.id, null, getData().settings.myLang);
      lines.push(`Sent to ${copy.target}.`);
    } catch (err) {
      lines.push(`Couldn’t send to ${PROVIDERS[a.provider].name}: ${err instanceof ConnectorError ? err.message : message(err)}`);
    }
  }
  return lines.length ? lines.join(' ') : null;
}
