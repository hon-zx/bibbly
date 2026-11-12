/** Short language codes used across Bibbly: "en", "zh" (Simplified), "zh-Hant", "yue", "ja", ... */
export type LangCode = string;

/** Where a line of speech came from. */
export type Channel = 'mic' | 'system' | 'stick' | 'remote' | 'demo';

export interface SpeakerRef {
  id: string;
  name: string;
  /** True for the person using this device. */
  self?: boolean;
}

/** One settled phrase of speech, with its translations. */
export interface Line {
  id: string;
  /** Seconds since the session started. */
  t: number;
  /** Optional end time in seconds. */
  end?: number;
  speaker: SpeakerRef;
  channel: Channel;
  text: string;
  /** Main spoken language, detected automatically. */
  lang: LangCode;
  /** Every language used when the speaker mixed languages. */
  langs?: LangCode[];
  /** Language-identification confidence, 0..1. */
  confidence?: number;
  /** Translations by language, filled in as they arrive. */
  tr: Record<LangCode, string>;
}

/** Text that is still being spoken (not settled yet). */
export interface PartialLine {
  channel: Channel;
  speaker: SpeakerRef;
  text: string;
  lang?: LangCode;
  t: number;
}

/** A clarity item with its source text and translations, keyed by language. */
export interface ClarityItem {
  src: LangCode;
  text: Record<LangCode, string>;
}

export interface ActionItem extends ClarityItem {
  id: string;
  owner: string;
  ownerIsMe: boolean;
  /** Epoch milliseconds, or null when no date was agreed. */
  due: number | null;
  lineId?: string;
}

export interface FollowUp extends ClarityItem {
  /** Epoch milliseconds, or null when no time was agreed. */
  when: number | null;
  durationMin: number;
}

export interface Clarity {
  summary: ClarityItem[];
  decisions: ClarityItem[];
  actions: ActionItem[];
  followup: FollowUp | null;
  updatedAt: number;
}

export interface Note {
  id: string;
  title: string;
  startedAt: number;
  durationSec: number;
  /** Human-readable capture source, e.g. "Laptop mic + meeting audio" or "Bibbly Stick". */
  source: string;
  platform?: Platform;
  languages: LangCode[];
  speakers: SpeakerRef[];
  lines: Line[];
  clarity: Clarity | null;
  sentTo: string[];
  /** Original audio kept on this device (Stick imports). */
  audioFile?: string;
  /** Why a recording has no transcript yet, e.g. no speech engine configured. */
  pendingReason?: string;
}

export type TaskList = 'Work' | 'Personal' | 'Home';

export interface Task {
  id: string;
  title: string;
  list: TaskList;
  /** Epoch milliseconds; midnight means "no time". */
  due: number | null;
  remind: boolean;
  done: boolean;
  doneAt?: number | null;
  repeat?: string;
  source?: { noteId: string; lineId?: string; actionId?: string };
}

export type Platform = 'zoom' | 'teams' | 'meet' | 'lark' | 'in-person' | 'other';

export interface CalendarEvent {
  id: string;
  title: string;
  start: number;
  durationMin: number;
  platform: Platform;
  languages?: LangCode[];
  bibblyJoins: boolean;
  attendees?: string;
  noteId?: string;
  prevNoteId?: string;
}
