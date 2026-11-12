import type { Clarity, LangCode, TaskList } from '../types.js';

export interface TranslateItem { id: string; text: string; speaker?: string }

export interface TranslateRequest {
  /** Language to translate into. */
  target: LangCode;
  items: TranslateItem[];
  /** Earlier lines ("Speaker: text"), for context only. */
  context?: string[];
  /** Names and product terms that must survive translation. */
  glossary?: string[];
  title?: string;
}

export interface TranslateResult {
  id: string;
  translation: string;
  /** Main language detected in the original, when the model could tell. */
  lang: LangCode | null;
  langs: LangCode[];
  confidence: number | null;
}

/** Anything that can translate utterances: Claude, a server relay, or a test fake. */
export interface Translator {
  translate(req: TranslateRequest, signal?: AbortSignal): Promise<TranslateResult[]>;
}

export interface ClarityRequest {
  /** Language to write the notes in. */
  lang: LangCode;
  title?: string;
  /** Name of the person using Bibbly, so their action items can be marked. */
  me: string;
  /** When the meeting started (epoch ms); relative dates are resolved against it. */
  startedAt: number;
  lines: { id: string; t: number; speaker: string; text: string }[];
  /** True for the final notes at the end of the meeting. */
  final: boolean;
}

export interface ClarityResult { title: string; clarity: Clarity }

export interface ClarityEngine {
  summarize(req: ClarityRequest, signal?: AbortSignal): Promise<ClarityResult>;
}

export interface RefinedTask { title: string; due: number | null; remind: boolean; list: TaskList }

export interface TaskRefiner {
  refine(text: string, now: number, signal?: AbortSignal): Promise<RefinedTask | null>;
}
