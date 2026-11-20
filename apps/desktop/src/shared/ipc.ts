import type { CalendarEvent, Channel, Clarity, ExportFormat, LangCode, Line, Member, Note, PartialLine, SharedCopy, Task } from '@bibbly/core';
import type { AccountSettings, ConnectedAccount, ConnectMethod, NoteTarget, ProviderId, ProviderInfo, SyncStatus } from '@bibbly/connectors';

/** Speech engine choice in Settings. */
export type EngineId = 'demo' | 'azure' | 'whisper';

export interface Settings {
  myName: string;
  /** Language Bibbly shows you captions and notes in. */
  myLang: LangCode;
  /** Languages people in your meetings speak (hints for engines that need them). */
  speaking: LangCode[];
  engine: EngineId;
  azureRegion: string;
  whisperUrl: string;
  claudeModel: string;
  fastMode: boolean;
  roomServer: string;
  glossary: string[];
}

export interface AppData {
  version: 1;
  notes: Note[];
  tasks: Task[];
  events: CalendarEvent[];
  settings: Settings;
}

export type SecretName = 'anthropicKey' | 'azureKey' | 'whisperKey';
export interface SecretStatus { anthropicKey: boolean; azureKey: boolean; whisperKey: boolean; envAnthropic: boolean; backend: string }

export interface StartOptions {
  mode: 'demo' | 'live';
  title?: string;
  channels: { mic: boolean; system: boolean; stick: boolean };
  shareRoom: boolean;
}

export interface StartResult {
  id: string;
  title: string;
  startedAt: number;
  room: { code: string; joinUrl: string } | null;
  warnings: string[];
}

/** Everything the main process tells the UI about a live session. */
export type SessionEvent =
  | { type: 'line'; line: Line }
  | { type: 'partial'; channel: Channel; partial: PartialLine | null }
  | { type: 'clarity'; clarity: Clarity; title: string }
  | { type: 'clarityStatus'; state: 'idle' | 'working' | 'error'; message?: string }
  | { type: 'error'; source: string; message: string }
  | { type: 'ended'; note: Note }
  | { type: 'room'; members: Member[]; connected: boolean };

export interface ExportResult { saved: boolean; path?: string }

export interface ImportMeta { startedAt: number; durationMs: number; title?: string }

/** A connected-app provider and the ways this computer can connect it. */
export interface ProviderView extends ProviderInfo { methods: ConnectMethod[] }

export interface ConnectorsView {
  accounts: ConnectedAccount[];
  status: Record<string, SyncStatus>;
  providers: ProviderView[];
  syncing: boolean;
  /** A sign-in waiting for the browser. */
  connecting: ProviderId | null;
  /** The Bibbly server that brokers sign-ins; reachable is null until checked. */
  server: { url: string; reachable: boolean | null; error?: string };
}

/** Something the user should hear about: a connected account, a note sent after a meeting, a failure. */
export interface ConnectorNotice { text: string; url?: string }

/** The API the preload script exposes on window.bibbly. */
export interface BibblyApi {
  platform: string;
  data: {
    get(): Promise<AppData>;
    saveTasks(tasks: Task[]): Promise<void>;
    saveEvents(events: CalendarEvent[]): Promise<void>;
    saveNote(note: Note): Promise<void>;
    deleteNote(id: string): Promise<void>;
    saveSettings(s: Settings): Promise<void>;
  };
  secrets: {
    status(): Promise<SecretStatus>;
    set(name: SecretName, value: string | null): Promise<SecretStatus>;
  };
  session: {
    start(o: StartOptions): Promise<StartResult>;
    frame(channel: Channel, pcm: ArrayBuffer): void;
    stop(): Promise<Note | null>;
    discard(): Promise<void>;
    summarize(): Promise<void>;
    retry(lineId: string, lang: LangCode): Promise<void>;
    watchLanguage(lang: LangCode, on: boolean): Promise<void>;
    translateNotes(lang: LangCode): Promise<void>;
    onEvent(cb: (e: SessionEvent) => void): () => void;
    snapshot(): Promise<{ lines: Line[]; partial: PartialLine | null } | null>;
  };
  notes: {
    export(noteId: string, format: ExportFormat, lang: LangCode, opts: { original: boolean; clarity: boolean }): Promise<ExportResult>;
    translate(noteId: string, lang: LangCode): Promise<Note>;
  };
  tasks: { refine(text: string): Promise<{ title: string; due: number | null; remind: boolean; list: 'Work' | 'Personal' | 'Home' } | null> };
  stick: {
    importRecording(wav: ArrayBuffer, meta: ImportMeta): Promise<Note>;
    simulatorAvailable(): Promise<boolean>;
    simulatorStart(): Promise<boolean>;
    simulatorStop(): Promise<void>;
    simulatorWrite(bytes: Uint8Array): void;
    onSimulatorData(cb: (bytes: Uint8Array) => void): () => void;
  };
  connectors: {
    view(): Promise<ConnectorsView>;
    connect(provider: ProviderId, token?: string): Promise<ConnectorsView>;
    cancelConnect(): Promise<void>;
    disconnect(accountId: string): Promise<ConnectorsView>;
    updateSettings(accountId: string, settings: AccountSettings): Promise<ConnectorsView>;
    targets(accountId: string): Promise<NoteTarget[]>;
    syncNow(): Promise<ConnectorsView>;
    publish(noteId: string, accountId: string, target: NoteTarget | null, lang: LangCode): Promise<SharedCopy>;
    onChanged(cb: (v: ConnectorsView) => void): () => void;
    onNotice(cb: (n: ConnectorNotice) => void): () => void;
  };
  mini: { toggle(show?: boolean): Promise<boolean> };
  openExternal(url: string): Promise<void>;
  onDataChanged(cb: (d: AppData) => void): () => void;
}
