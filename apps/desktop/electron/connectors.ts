/**
 * Connected apps on desktop: sign-in, tokens in the OS keychain, background
 * sync of tasks and calendar, and sending notes to Google Docs, Teams, Slack,
 * Notion and Lark.
 *
 * Sign-in goes straight from this computer to Google or Microsoft when the
 * build has their desktop client ids (no secret involved), and otherwise
 * through the Bibbly server's broker, which holds the client secrets. Slack
 * and Notion also accept a pasted bot or integration token.
 */
import fs from 'node:fs';
import path from 'node:path';
import { powerMonitor, safeStorage, shell } from 'electron';
import type { LangCode, Note, SharedCopy } from '@bibbly/core';
import {
  BrokerClient, ConnectorError, Connectors, Http, PROVIDERS, PROVIDER_IDS, applySyncResult, defaultEndpoints, emptyConnectorState, endpointsAt,
  exchangeCode, oauthApp, refreshTokens,
  type AccountSettings, type BrokerProvider, type ClientConfig, type ConnectMethod, type ConnectorState, type Endpoints, type NoteTarget,
  type ProviderId, type TokenSet, type TokenStore,
} from '@bibbly/connectors';
import { brokerAuthorize, loopbackAuthorize } from '@bibbly/connectors/node';
import type { ConnectorNotice, ConnectorsView } from '../src/shared/ipc.js';
import type { DataStore } from './store.js';

// Filled in at build time from the environment (scripts/build-electron.mjs).
declare const __BIBBLY_GOOGLE_DESKTOP_CLIENT_ID__: string;
declare const __BIBBLY_GOOGLE_DESKTOP_CLIENT_SECRET__: string;
declare const __BIBBLY_MICROSOFT_CLIENT_ID__: string;

const SYNC_EVERY_MS = 5 * 60_000;

/**
 * Sign-ins, encrypted with the OS keychain (Keychain, DPAPI, libsecret or
 * KWallet). On Linux without a keyring, Electron falls back to its basic_text
 * backend, which only obfuscates; Settings says so.
 */
class KeychainTokens implements TokenStore {
  private loading: Promise<Record<string, TokenSet>> | null = null;
  private writing: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}

  private load(): Promise<Record<string, TokenSet>> {
    this.loading ??= (async () => {
      const out: Record<string, TokenSet> = {};
      let raw: Record<string, string>;
      try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, string>; } catch { return out; }
      for (const [id, v] of Object.entries(raw)) {
        try { out[id] = JSON.parse((await safeStorage.decryptStringAsync(Buffer.from(v, 'base64'))).result) as TokenSet; }
        catch { /* encrypted under another keychain: that account needs connecting again */ }
      }
      return out;
    })();
    return this.loading;
  }

  async get(id: string) { return (await this.load())[id] ?? null; }

  async set(id: string, t: TokenSet | null) {
    const cache = await this.load();
    if (t) cache[id] = t; else delete cache[id];
    const write = this.writing.catch(() => undefined).then(async () => {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('Your system keychain isn’t available, so Bibbly can’t store this sign-in safely.');
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(cache)) out[k] = (await safeStorage.encryptStringAsync(JSON.stringify(v))).toString('base64');
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(out), { mode: 0o600 });
      fs.renameSync(`${this.file}.tmp`, this.file);
    });
    this.writing = write;
    await write;
  }
}

const isExample = (x: { id: string }) => x.id.startsWith('example-');

/** Plays the browser in end-to-end tests: follows the consent page's redirects. */
async function fetchBrowser(url: string) {
  let at = url;
  for (let i = 0; i < 6 && /^https?:/.test(at); i++) {
    const res = await fetch(at, { redirect: 'manual' }).catch(() => null);
    const loc = res?.headers.get('location');
    if (!loc) return;
    at = new URL(loc, at).toString();
  }
}

export interface ConnectorServiceOptions {
  dir: string;
  store: DataStore;
  /** Bibbly server address (Settings), for the sign-in broker. */
  serverUrl: () => string;
  onChange: (v: ConnectorsView) => void;
  onData: () => void;
  notify: (n: ConnectorNotice) => void;
}

export class ConnectorService {
  private state: ConnectorState;
  private readonly file: string;
  private readonly connectors: Connectors;
  private readonly ep: Endpoints;
  private readonly direct: Partial<Record<ProviderId, ClientConfig>> = {};
  private server: { url: string; at: number; providers: BrokerProvider[] | null; error?: string } | null = null;
  private running: Promise<void> | null = null;
  private syncing = false;
  private again = false;
  private soon: NodeJS.Timeout | null = null;
  private every: NodeJS.Timeout | null = null;
  private connecting: { provider: ProviderId; abort: AbortController } | null = null;

  constructor(private readonly o: ConnectorServiceOptions) {
    this.file = path.join(o.dir, 'connectors.json');
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ConnectorState;
      this.state = saved.version === 1 ? saved : emptyConnectorState();
    } catch { this.state = emptyConnectorState(); }
    const env = process.env;
    this.ep = env.BIBBLY_PROVIDER_BASE_URL ? endpointsAt(env.BIBBLY_PROVIDER_BASE_URL) : defaultEndpoints(env.BIBBLY_MICROSOFT_TENANT ? { microsoftTenant: env.BIBBLY_MICROSOFT_TENANT } : {});
    const googleId = env.BIBBLY_GOOGLE_DESKTOP_CLIENT_ID || __BIBBLY_GOOGLE_DESKTOP_CLIENT_ID__;
    const googleSecret = env.BIBBLY_GOOGLE_DESKTOP_CLIENT_SECRET || __BIBBLY_GOOGLE_DESKTOP_CLIENT_SECRET__;
    const msId = env.BIBBLY_MICROSOFT_CLIENT_ID || __BIBBLY_MICROSOFT_CLIENT_ID__;
    // Google requires its desktop clients' (non-confidential) secret alongside PKCE.
    if (googleId) this.direct.google = { clientId: googleId, ...(googleSecret ? { clientSecret: googleSecret } : {}) };
    if (msId) this.direct.microsoft = { clientId: msId };
    this.connectors = new Connectors({
      tokens: new KeychainTokens(path.join(o.dir, 'connector-tokens.json')),
      endpoints: this.ep,
      refresh: (account, rt) => {
        const client = this.direct[account.provider];
        if (account.method === 'loopback' && client) return refreshTokens(oauthApp(account.provider, client, this.ep), rt, new Http(PROVIDERS[account.provider].name));
        return this.broker().refresh(account.provider, rt);
      },
    });
  }

  /** Starts background sync: soon after launch, every few minutes, and after the computer wakes. */
  start() {
    this.every = setInterval(() => void this.syncNow(), SYNC_EVERY_MS);
    this.scheduleSync(3000);
    powerMonitor.on('resume', () => this.scheduleSync(5000));
  }

  stop() {
    if (this.every) clearInterval(this.every);
    if (this.soon) clearTimeout(this.soon);
    this.connecting?.abort.abort();
  }

  private broker() { return new BrokerClient(this.o.serverUrl()); }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  private changed() { this.o.onChange(this.view()); }

  /** Asks the Bibbly server which apps it can connect (cached for a minute). */
  async checkServer(force = false): Promise<void> {
    const url = this.o.serverUrl();
    if (!force && this.server?.url === url && Date.now() - this.server.at < 60_000) return;
    try {
      this.server = { url, at: Date.now(), providers: await this.broker().providers() };
    } catch (err) {
      this.server = { url, at: Date.now(), providers: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private methods(p: ProviderId): ConnectMethod[] {
    const m: ConnectMethod[] = [];
    if (this.direct[p]) m.push('loopback');
    else if (this.server?.providers?.some(x => x.id === p && x.configured)) m.push('broker');
    if (PROVIDERS[p].tokenHint) m.push('token');
    return m;
  }

  view(): ConnectorsView {
    return {
      accounts: this.state.accounts,
      status: this.state.status,
      providers: PROVIDER_IDS.map(id => ({ ...PROVIDERS[id], methods: this.methods(id) })),
      syncing: this.syncing,
      connecting: this.connecting?.provider ?? null,
      server: { url: this.o.serverUrl(), reachable: this.server ? this.server.providers !== null : null, ...(this.server?.error ? { error: this.server.error } : {}) },
    };
  }

  /** Signs in (or saves a pasted token), adds the account, and syncs it. */
  async connect(provider: ProviderId, token?: string): Promise<ConnectorsView> {
    this.connecting?.abort.abort();
    const abort = new AbortController();
    this.connecting = { provider, abort };
    this.changed();
    try {
      let tokens: TokenSet;
      let method: ConnectMethod;
      const open = (url: string) => (process.env.BIBBLY_E2E_BROWSER === 'fetch' ? void fetchBrowser(url) : shell.openExternal(url));
      const client = this.direct[provider];
      if (token?.trim()) {
        method = 'token';
        tokens = { accessToken: token.trim() };
      } else if (client) {
        method = 'loopback';
        const app = oauthApp(provider, client, this.ep);
        const code = await loopbackAuthorize(app, { open, signal: abort.signal });
        tokens = (await exchangeCode(app, code, new Http(PROVIDERS[provider].name))).tokens;
      } else {
        await this.checkServer(true);
        if (!this.methods(provider).includes('broker')) {
          throw new Error(this.server?.providers === null
            ? `Bibbly couldn’t reach its server at ${this.o.serverUrl()} to connect ${PROVIDERS[provider].name}. Check the server address below.`
            : `The Bibbly server at ${this.o.serverUrl()} isn’t set up to connect ${PROVIDERS[provider].name} yet (see docs/connectors.md).`);
        }
        method = 'broker';
        tokens = await brokerAuthorize(this.broker(), provider, { open, signal: abort.signal });
      }
      const r = await this.connectors.addAccount(this.state, provider, method, tokens);
      this.state = r.state;
      this.save();
      this.o.notify({ text: `Connected ${r.account.label}.` });
      void this.syncNow();
      return this.view();
    } finally {
      if (this.connecting?.abort === abort) this.connecting = null;
      this.changed();
    }
  }

  cancelConnect() { this.connecting?.abort.abort(); }

  async disconnect(accountId: string): Promise<ConnectorsView> {
    await this.running;
    const { tasks, events } = this.o.store.data;
    const r = await this.connectors.removeAccount(this.state, accountId, { tasks, events });
    this.state = r.state;
    this.save();
    this.o.store.update(r.data);
    this.o.onData();
    this.changed();
    return this.view();
  }

  updateSettings(accountId: string, settings: AccountSettings): ConnectorsView {
    const before = this.state.accounts.find(a => a.id === accountId)?.settings;
    this.state = this.connectors.updateSettings(this.state, accountId, settings);
    this.save();
    this.changed();
    const turnedOn = (!before?.calendar?.enabled && settings.calendar?.enabled) || (!before?.tasks?.enabled && settings.tasks?.enabled)
      || (before?.calendar?.push === false && settings.calendar?.push);
    if (turnedOn) this.scheduleSync(500);
    return this.view();
  }

  async targets(accountId: string): Promise<NoteTarget[]> {
    const account = this.state.accounts.find(a => a.id === accountId);
    if (!account) throw new Error('That account is no longer connected.');
    const api = this.connectors.notes(account);
    return api ? api.listTargets() : [];
  }

  /** Runs a sync after local changes settle. */
  scheduleSync(delayMs = 8000) {
    if (!this.state.accounts.some(a => a.settings.calendar?.enabled || a.settings.tasks?.enabled)) return;
    if (this.soon) clearTimeout(this.soon);
    this.soon = setTimeout(() => { this.soon = null; void this.syncNow(); }, delayMs);
  }

  /** Syncs every account's calendar and tasks with Bibbly's. One run at a time; a request during a run queues one more. */
  syncNow(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    if (!this.state.accounts.some(a => a.settings.calendar?.enabled || a.settings.tasks?.enabled)) return Promise.resolve();
    this.syncing = true;
    this.changed();
    this.running = (async () => {
      do {
        this.again = false;
        const before = this.o.store.data;
        const tasks = before.tasks.filter(t => !isExample(t));
        const events = before.events.filter(e => !isExample(e));
        const r = await this.connectors.syncAll(this.state, { tasks, events });
        this.state = r.state;
        this.save();
        const cur = this.o.store.data;
        const merged = applySyncResult({ tasks, events }, r.data, { tasks: cur.tasks.filter(t => !isExample(t)), events: cur.events.filter(e => !isExample(e)) });
        this.o.store.update({ tasks: [...cur.tasks.filter(isExample), ...merged.tasks], events: [...cur.events.filter(isExample), ...merged.events] });
        this.o.onData();
      } while (this.again);
    })().catch(err => {
      this.o.notify({ text: `Sync stopped: ${err instanceof Error ? err.message : String(err)}` });
    }).finally(() => {
      this.running = null;
      this.syncing = false;
      this.changed();
    });
    return this.running;
  }

  /** Sends a note to a connected app and records where it went. */
  async publish(noteId: string, accountId: string, target: NoteTarget | null, lang: LangCode): Promise<SharedCopy> {
    const note = this.o.store.data.notes.find(n => n.id === noteId);
    if (!note) throw new Error('That note no longer exists.');
    const account = this.state.accounts.find(a => a.id === accountId);
    if (!account) throw new Error('That account is no longer connected.');
    const copy = await this.connectors.publish(account, note, { lang, myName: this.o.store.data.settings.myName }, target ?? undefined);
    const name = PROVIDERS[account.provider].name;
    this.o.store.update({
      notes: this.o.store.data.notes.map(n => (n.id === noteId ? { ...n, shared: [...(n.shared ?? []), copy], sentTo: [...new Set([...n.sentTo, name])] } : n)),
    });
    this.o.onData();
    return copy;
  }

  /** After a meeting: sends the notes everywhere "Send every note" is on. */
  async autoPublish(note: Note): Promise<void> {
    const lang = this.o.store.data.settings.myLang;
    for (const a of this.state.accounts) {
      const n = a.settings.notes;
      if (!n?.enabled || !n.auto || (!n.target && a.provider !== 'google')) continue;
      try {
        const copy = await this.publish(note.id, a.id, null, lang);
        this.o.notify({ text: `Sent “${note.title}” to ${copy.target}.`, ...(copy.url ? { url: copy.url } : {}) });
      } catch (err) {
        const e = err instanceof ConnectorError ? err : null;
        this.o.notify({ text: `Couldn’t send “${note.title}” to ${PROVIDERS[a.provider].name}: ${e?.message ?? String(err)}` });
      }
    }
  }
}
