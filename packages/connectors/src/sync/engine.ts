/**
 * Connectors: the one object the apps use. It keeps tokens fresh, builds the
 * right client for each connected app, runs calendar and task sync for every
 * account, and sends notes.
 */
import type { CalendarEvent, Note, ProviderId, SharedCopy, Task } from '@bibbly/core';
import { ConnectorError, Http, type AuthSource } from '../http.js';
import type { ApiCtx } from '../providers/ctx.js';
import { googleCalendar, googleDrive, googleProfile, googleTasks } from '../providers/google.js';
import { larkCalendar, larkChats, larkProfile, larkTasks } from '../providers/lark.js';
import { microsoftProfile, microsoftTodo, outlookCalendar, teamsChannels } from '../providers/microsoft.js';
import { notionPages, notionProfile } from '../providers/notion.js';
import { defaultEndpoints, PROVIDERS, type Endpoints } from '../providers/registry.js';
import { slackChannels, slackProfile } from '../providers/slack.js';
import type { AccountSettings, CalendarApi, ConnectedAccount, ConnectMethod, ConnectorState, NotesApi, NoteTarget, Profile, PublishOptions, SyncStatus, TaskApi, TokenSet } from '../types.js';
import { syncCalendar } from './calendar.js';
import { syncTasks } from './tasks.js';

/** Where tokens live: the OS keychain on desktop, SecureStore on mobile. */
export interface TokenStore {
  get(accountId: string): Promise<TokenSet | null>;
  set(accountId: string, tokens: TokenSet | null): Promise<void>;
}

/** Exchanges a refresh token: locally for public clients, or through the Bibbly server. */
export type Refresher = (account: ConnectedAccount, refreshToken: string) => Promise<TokenSet>;

export interface ConnectorsOptions {
  tokens: TokenStore;
  refresh: Refresher;
  endpoints?: Endpoints;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface SyncData { tasks: Task[]; events: CalendarEvent[] }

export interface SyncResult { state: ConnectorState; data: SyncData; status: Record<string, SyncStatus> }

export class Connectors {
  readonly ep: Endpoints;
  private readonly refreshing = new Map<string, Promise<TokenSet>>();

  constructor(private readonly opts: ConnectorsOptions) {
    this.ep = opts.endpoints ?? defaultEndpoints();
  }

  private now() { return (this.opts.now ?? Date.now)(); }

  private http(provider: ProviderId) {
    return new Http(PROVIDERS[provider].name, { ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}), ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}) });
  }

  private async refreshNow(account: ConnectedAccount, current: TokenSet): Promise<TokenSet> {
    const pending = this.refreshing.get(account.id);
    if (pending) return pending;
    const run = (async () => {
      if (!current.refreshToken) throw new ConnectorError(`${PROVIDERS[account.provider].name} needs you to connect again.`, account.provider, 401, 'invalid_grant');
      const next = await this.opts.refresh(account, current.refreshToken);
      const merged: TokenSet = { ...current, ...next, extra: { ...current.extra, ...next.extra } };
      await this.opts.tokens.set(account.id, merged);
      return merged;
    })();
    this.refreshing.set(account.id, run);
    try { return await run; } finally { this.refreshing.delete(account.id); }
  }

  /** Access tokens for API calls: refreshed a minute before they expire, and once more after a 401. */
  auth(account: ConnectedAccount): AuthSource {
    const name = PROVIDERS[account.provider].name;
    return {
      token: async () => {
        let t = await this.opts.tokens.get(account.id);
        if (!t) throw new ConnectorError(`${name} isn't connected on this device. Connect it again in Settings.`, account.provider, 401, 'no_token');
        if (t.expiresAt && t.refreshToken && t.expiresAt - this.now() < 60_000) t = await this.refreshNow(account, t);
        return t.accessToken;
      },
      refresh: async () => {
        const t = await this.opts.tokens.get(account.id);
        if (!t?.refreshToken) throw new ConnectorError(`${name} no longer accepts Bibbly's connection. Connect it again in Settings.`, account.provider, 401, 'invalid_grant');
        return (await this.refreshNow(account, t)).accessToken;
      },
    };
  }

  ctx(account: ConnectedAccount): ApiCtx {
    return { http: this.http(account.provider), auth: this.auth(account), ep: this.ep, now: () => this.now() };
  }

  calendar(account: ConnectedAccount): CalendarApi | null {
    const c = this.ctx(account);
    return account.provider === 'google' ? googleCalendar(c) : account.provider === 'microsoft' ? outlookCalendar(c) : account.provider === 'lark' ? larkCalendar(c) : null;
  }

  tasks(account: ConnectedAccount): TaskApi | null {
    const c = this.ctx(account);
    return account.provider === 'google' ? googleTasks(c) : account.provider === 'microsoft' ? microsoftTodo(c) : account.provider === 'lark' ? larkTasks(c) : null;
  }

  notes(account: ConnectedAccount): NotesApi | null {
    const c = this.ctx(account);
    switch (account.provider) {
      case 'google': return googleDrive(c);
      case 'microsoft': return teamsChannels(c);
      case 'slack': return slackChannels(c);
      case 'notion': return notionPages(c);
      case 'lark': return larkChats(c);
    }
  }

  /** Who the tokens belong to, for the account label. */
  async profile(provider: ProviderId, tokens: TokenSet): Promise<Profile> {
    const c: ApiCtx = { http: this.http(provider), auth: { token: async () => tokens.accessToken }, ep: this.ep };
    switch (provider) {
      case 'google': return googleProfile(tokens, c);
      case 'microsoft': return microsoftProfile(tokens, c);
      case 'slack': return slackProfile(c);
      case 'notion': return notionProfile(tokens, c);
      case 'lark': return larkProfile(c);
    }
  }

  defaultSettings(provider: ProviderId, state: ConnectorState): AccountSettings {
    const caps = PROVIDERS[provider].capabilities;
    const calendarTaken = state.accounts.some(a => a.settings.calendar?.push);
    return {
      ...(caps.includes('calendar') ? { calendar: { enabled: true, calendarId: 'primary', push: !calendarTaken } } : {}),
      ...(caps.includes('tasks') ? { tasks: { enabled: true, listName: 'Bibbly', localList: 'Work' as const } } : {}),
      ...(caps.includes('notes') ? { notes: { enabled: true, auto: false } } : {}),
    };
  }

  /** Saves the tokens and adds the account (or refreshes an existing one, keeping its settings). */
  async addAccount(state: ConnectorState, provider: ProviderId, method: ConnectMethod, tokens: TokenSet): Promise<{ state: ConnectorState; account: ConnectedAccount }> {
    const profile = await this.profile(provider, tokens);
    const id = `${provider}:${profile.id}`;
    // The id_token was only needed to read the profile; don't keep it (mobile keychains have size limits).
    const { id_token: _idToken, ...extra } = tokens.extra ?? {};
    await this.opts.tokens.set(id, { ...tokens, extra });
    const existing = state.accounts.find(a => a.id === id);
    const account: ConnectedAccount = existing
      ? { ...existing, label: profile.label, method }
      : { id, provider, label: profile.label, method, connectedAt: this.now(), settings: this.defaultSettings(provider, state) };
    return { state: { ...state, accounts: existing ? state.accounts.map(a => (a.id === id ? account : a)) : [...state.accounts, account] }, account };
  }

  /** Asks the app to revoke Bibbly's access, where it offers that (Google, Slack). Best effort. */
  async revoke(account: ConnectedAccount): Promise<boolean> {
    const t = await this.opts.tokens.get(account.id);
    if (!t) return false;
    const http = this.http(account.provider);
    try {
      if (account.provider === 'google') {
        await http.request({ method: 'POST', url: this.ep.googleRevoke, form: { token: t.refreshToken ?? t.accessToken }, expect: 'none' });
        return true;
      }
      if (account.provider === 'slack') {
        await http.request({ method: 'POST', url: `${this.ep.slackApi}/auth.revoke`, auth: { token: async () => t.accessToken }, form: {}, expect: 'none' });
        return true;
      }
    } catch { /* already revoked, or offline: the tokens are deleted here either way */ }
    return false;
  }

  /** Disconnects: revokes access where possible, forgets tokens and links, and removes calendar events that only came from that account. */
  async removeAccount(state: ConnectorState, accountId: string, data: SyncData): Promise<{ state: ConnectorState; data: SyncData }> {
    const account = state.accounts.find(a => a.id === accountId);
    if (account) await this.revoke(account);
    await this.opts.tokens.set(accountId, null);
    const events = data.events
      .filter(e => !(e.source?.accountId === accountId && e.source.readOnly && !e.noteId))
      .map(e => {
        if (e.source?.accountId !== accountId) return e;
        const { source: _gone, ...rest } = e;
        return rest;
      });
    const tasks = data.tasks.map(t => (t.synced?.some(s => s.accountId === accountId) ? { ...t, synced: t.synced.filter(s => s.accountId !== accountId) } : t));
    const { [accountId]: _status, ...status } = state.status;
    return {
      state: { ...state, accounts: state.accounts.filter(a => a.id !== accountId), links: state.links.filter(l => l.accountId !== accountId), status },
      data: { tasks, events },
    };
  }

  updateSettings(state: ConnectorState, accountId: string, settings: AccountSettings): ConnectorState {
    // Only one calendar receives Bibbly's events.
    const pushing = settings.calendar?.push;
    return {
      ...state,
      accounts: state.accounts.map(a => {
        if (a.id === accountId) return { ...a, settings };
        if (pushing && a.settings.calendar?.push) return { ...a, settings: { ...a.settings, calendar: { ...a.settings.calendar, push: false } } };
        return a;
      }),
    };
  }

  /** Syncs one account's calendar and tasks. Errors land in the returned status, not as exceptions. */
  async syncAccount(state: ConnectorState, data: SyncData, accountId: string): Promise<SyncResult> {
    let account = state.accounts.find(a => a.id === accountId);
    if (!account) return { state, data, status: state.status };
    let links = state.links;
    let { tasks, events } = data;
    const counts = { pulled: 0, pushed: 0, removed: 0 };
    const add = (r: { pulled: number; pushed: number; removed: number }) => { counts.pulled += r.pulled; counts.pushed += r.pushed; counts.removed += r.removed; };
    let status: SyncStatus;
    try {
      const cal = account.settings.calendar;
      const calApi = cal?.enabled ? this.calendar(account) : null;
      if (cal && calApi) {
        let calendarId = cal.calendarId;
        if (account.provider === 'lark' && (!calendarId || calendarId === 'primary')) {
          const primary = await calApi.primaryCalendar();
          calendarId = primary.id;
          account = { ...account, settings: { ...account.settings, calendar: { ...cal, calendarId, calendarName: primary.name } } };
        }
        const r = await syncCalendar(calApi, account, calendarId, events, links, this.now(), { push: cal.push });
        events = r.events; links = r.links; add(r);
      }
      const ts = account.settings.tasks;
      const taskApi = ts?.enabled ? this.tasks(account) : null;
      if (ts && taskApi) {
        let listId = ts.listId;
        if (!listId) {
          const list = await taskApi.findOrCreateList(ts.listName);
          listId = list.id;
          account = { ...account, settings: { ...account.settings, tasks: { ...ts, listId } } };
        }
        const r = await syncTasks(taskApi, account, listId, tasks, links, this.now());
        tasks = r.tasks; links = r.links; add(r);
      }
      status = { at: this.now(), ok: true, ...counts };
    } catch (err) {
      const e = err as ConnectorError;
      status = { at: this.now(), ok: false, message: e.message ?? String(err), ...counts };
    }
    const acct = account;
    const next: ConnectorState = { ...state, accounts: state.accounts.map(a => (a.id === acct.id ? acct : a)), links, status: { ...state.status, [acct.id]: status } };
    return { state: next, data: { tasks, events }, status: next.status };
  }

  /** Syncs every account that has calendar or task sync turned on, one after another. */
  async syncAll(state: ConnectorState, data: SyncData): Promise<SyncResult> {
    let cur: SyncResult = { state, data, status: state.status };
    for (const a of state.accounts) {
      if (!a.settings.calendar?.enabled && !a.settings.tasks?.enabled) continue;
      cur = await this.syncAccount(cur.state, cur.data, a.id);
    }
    return cur;
  }

  /** Sends a note to an account's notes destination (or the target given). */
  async publish(account: ConnectedAccount, note: Note, opts: PublishOptions, target?: NoteTarget): Promise<SharedCopy> {
    const api = this.notes(account);
    if (!api) throw new ConnectorError(`${PROVIDERS[account.provider].name} can't receive notes.`, account.provider, 400, 'unsupported');
    const dest = target ?? account.settings.notes?.target ?? (account.provider === 'google' ? (await api.listTargets())[0] : undefined);
    if (!dest) throw new ConnectorError(`Choose where ${PROVIDERS[account.provider].name} notes go in Settings.`, account.provider, 400, 'no_target');
    const res = await api.publish(dest, note, opts);
    return { provider: account.provider, target: dest.name, ...(res.url ? { url: res.url } : {}), at: this.now() };
  }
}
