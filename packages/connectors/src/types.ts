import type { LangCode, Note, Platform, ProviderId, TaskList } from '@bibbly/core';

export type { ProviderId };

/** What a connected app can do for Bibbly. */
export type Capability = 'calendar' | 'tasks' | 'notes';

/** OAuth tokens (or a pasted integration token) for one connected account. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires; absent when it doesn't. */
  expiresAt?: number;
  scope?: string;
  /** Provider details kept with the token: Slack team, Notion workspace, id_token... */
  extra?: Record<string, string>;
}

/**
 * How the account was connected:
 * loopback = OAuth in the system browser with a local redirect (desktop, public clients);
 * broker   = OAuth through the Bibbly server, which holds the client secret;
 * token    = an integration token pasted by the user (Notion internal integration, Slack bot token).
 */
export type ConnectMethod = 'loopback' | 'broker' | 'token';

export interface AccountSettings {
  calendar?: { enabled: boolean; calendarId: string; calendarName?: string; /** Save events made in Bibbly (follow-ups) here. */ push: boolean };
  tasks?: { enabled: boolean; listId?: string; listName: string; /** Bibbly list for tasks created in the other app. */ localList: TaskList };
  notes?: { enabled: boolean; /** Send every note when a session ends. */ auto: boolean; target?: NoteTarget };
}

export interface ConnectedAccount {
  /** provider:account (email, workspace or user id). */
  id: string;
  provider: ProviderId;
  /** What the user recognises: their email or workspace name. */
  label: string;
  method: ConnectMethod;
  connectedAt: number;
  settings: AccountSettings;
}

/** Pairs a Bibbly task or event with its copy in a connected app. */
export interface SyncLink {
  kind: 'task' | 'event';
  accountId: string;
  localId: string;
  remoteId: string;
  /** Task list or calendar id in the connected app. */
  container: string;
  /** Where the item was created. For events, that side owns the title and time. */
  origin: 'local' | 'remote';
  /** Bibbly's updatedAt when last synced. */
  localVersion: string;
  /** The connected app's updated time or etag when last synced. */
  remoteVersion: string;
  syncedAt: number;
}

export interface SyncStatus {
  at: number;
  ok: boolean;
  message?: string;
  pulled: number;
  pushed: number;
  removed: number;
}

/** Everything the apps persist about connected apps, apart from tokens (those live in the keychain). */
export interface ConnectorState {
  version: 1;
  accounts: ConnectedAccount[];
  links: SyncLink[];
  status: Record<string, SyncStatus>;
}

export const emptyConnectorState = (): ConnectorState => ({ version: 1, accounts: [], links: [], status: {} });

/* ---- Normalised shapes the provider clients speak ---- */

export interface RemoteTask {
  id: string;
  title: string;
  notes?: string;
  due: number | null;
  /** False when the app stores only a date (Google Tasks). */
  dueHasTime: boolean;
  completed: boolean;
  completedAt: number | null;
  /** Epoch ms of the last change in the app; 0 when the app doesn't say. */
  updated: number;
  /** Changes whenever the task changes in the app (updated time, etag or a content hash). */
  version: string;
  url?: string;
}

export interface TaskInput {
  title: string;
  notes?: string;
  due: number | null;
  dueHasTime: boolean;
  completed: boolean;
  remind: boolean;
}

export interface TaskApi {
  findOrCreateList(name: string): Promise<{ id: string; name: string }>;
  listTasks(listId: string): Promise<RemoteTask[]>;
  createTask(listId: string, t: TaskInput): Promise<RemoteTask>;
  updateTask(listId: string, id: string, t: TaskInput): Promise<RemoteTask>;
  deleteTask(listId: string, id: string): Promise<void>;
}

export interface RemoteEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location?: string;
  description?: string;
  meetUrl?: string;
  platform: Platform;
  attendees?: string;
  /** Changes whenever the event changes (updated time or etag). */
  version: string;
  url?: string;
}

export interface EventInput {
  title: string;
  start: number;
  end: number;
  description?: string;
  location?: string;
  platform: Platform;
  /** Ask the calendar to attach a video meeting (Meet, Teams or Lark). */
  addMeeting?: boolean;
}

export interface CalendarApi {
  primaryCalendar(): Promise<{ id: string; name: string }>;
  listEvents(calendarId: string, from: number, to: number): Promise<RemoteEvent[]>;
  createEvent(calendarId: string, e: EventInput): Promise<RemoteEvent>;
  updateEvent(calendarId: string, id: string, e: EventInput): Promise<RemoteEvent>;
  deleteEvent(calendarId: string, id: string): Promise<void>;
}

/** A Slack channel, Notion page, Teams channel, Drive folder or Lark chat that notes go to. */
export interface NoteTarget {
  id: string;
  name: string;
  detail?: string;
}

export interface PublishOptions {
  lang: LangCode;
  myName?: string;
}

export interface NotesApi {
  listTargets(): Promise<NoteTarget[]>;
  publish(target: NoteTarget, note: Note, opts: PublishOptions): Promise<{ url?: string }>;
}

export interface Profile {
  /** Stable id within the provider (user id, email or workspace id). */
  id: string;
  label: string;
}
