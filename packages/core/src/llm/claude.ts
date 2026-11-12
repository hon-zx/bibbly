import Anthropic from '@anthropic-ai/sdk';
import { parseDateTime } from '../dates.js';
import { langName, LANGUAGES, normLang } from '../lang.js';
import type { ActionItem, Clarity, ClarityItem, LangCode, TaskList } from '../types.js';
import { uid } from '../util.js';
import type {
  ClarityEngine, ClarityRequest, ClarityResult, RefinedTask, TaskRefiner, TranslateRequest, TranslateResult, Translator,
} from './types.js';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
type Effort = 'low' | 'medium' | 'high';

export interface ClaudeConfig {
  /** Leave unset to use ANTHROPIC_API_KEY or an `ant auth login` profile. */
  apiKey?: string;
  /** Inject a preconfigured client (tests, proxies, other platforms). */
  client?: Anthropic;
  model?: string;
  /** Fast mode: faster output at premium pricing (Claude Opus 5.5). Off by default. */
  fast?: boolean;
}

/** Claude declined the request after server-side fallbacks were tried. */
export class ClaudeRefusalError extends Error {
  constructor(readonly category: string | null) {
    super('Claude declined to process this text');
    this.name = 'ClaudeRefusalError';
  }
}

const CODES = LANGUAGES.map(l => l.code).join(', ');

const TRANSLATE_SYSTEM = `You are Bibbly's live meeting interpreter. People in a meeting may speak any language, and they often mix languages in one sentence, for example Mandarin with English words.

For each utterance you receive:
1. Identify the language or languages actually spoken. Use these codes: ${CODES}. Put the main language in "lang", every language used in "langs", and how sure you are (0 to 1) in "confidence".
2. Translate it into the target language the way a skilled interpreter would: natural, concise and faithful. Keep names, numbers, dates, prices and product names exactly as said. Turn a mixed-language sentence into one fluent sentence.
3. If an utterance is already entirely in the target language, return it unchanged.

Earlier lines are context only. Translate only the listed items and return exactly one result per item id.`;

const CLARITY_SYSTEM = `You are Bibbly, a meeting assistant. You read a meeting transcript, which may mix several languages, and write clear notes: a short summary, the decisions that were made, the action items with their owners and due dates, and any follow-up meeting that was agreed.

Rules:
- Write every text field in the requested output language.
- Include only what was actually said. Never invent owners, dates or decisions.
- The owner of an action item is the person who agreed to do it. Set "owner_is_me" when that is the person using Bibbly.
- Resolve relative dates such as "tomorrow", "by the end of the week" or "next Tuesday at 10" against the meeting date you are given. Use null when no date or time was agreed.
- Use the id of the transcript line where each action item was agreed.
- At most 5 summary bullets, each under 25 words.
- The title is a short name for the meeting.`;

const TASK_SYSTEM = `You turn a to-do that someone typed or said, in any language, into structured data. Keep the title in the same language as the to-do, short and starting with a verb where natural. Resolve dates relative to the current date you are given. "remind" is true when the person asked to be reminded or gave a specific time. Pick the list that fits: Work, Personal or Home.`;

const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });

const TRANSLATE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, lang: { type: 'string' }, langs: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' }, translation: { type: 'string' },
        },
        required: ['id', 'lang', 'langs', 'confidence', 'translation'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const CLARITY_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          owner: { type: 'string' }, owner_is_me: { type: 'boolean' }, task: { type: 'string' },
          due_date: nullable({ type: 'string' }), due_time: nullable({ type: 'string' }), line_id: nullable({ type: 'string' }),
        },
        required: ['owner', 'owner_is_me', 'task', 'due_date', 'due_time', 'line_id'],
        additionalProperties: false,
      },
    },
    followup: nullable({
      type: 'object',
      properties: { title: { type: 'string' }, date: nullable({ type: 'string' }), time: nullable({ type: 'string' }), duration_min: { type: 'integer' } },
      required: ['title', 'date', 'time', 'duration_min'],
      additionalProperties: false,
    }),
  },
  required: ['title', 'summary', 'decisions', 'actions', 'followup'],
  additionalProperties: false,
};

const TASK_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' }, date: nullable({ type: 'string' }), time: nullable({ type: 'string' }),
    remind: { type: 'boolean' }, list: { type: 'string', enum: ['Work', 'Personal', 'Home'] },
  },
  required: ['title', 'date', 'time', 'remind', 'list'],
  additionalProperties: false,
};

interface CallArgs { system: string; user: string; schema: object; effort: Effort; maxTokens: number; signal?: AbortSignal }

/** Translation, meeting notes and task parsing on Claude. */
export class Claude implements Translator, ClarityEngine, TaskRefiner {
  readonly client: Anthropic;
  model: string;
  fast: boolean;

  constructor(cfg: ClaudeConfig = {}) {
    this.client = cfg.client ?? new Anthropic(cfg.apiKey ? { apiKey: cfg.apiKey } : {});
    this.model = cfg.model ?? DEFAULT_CLAUDE_MODEL;
    this.fast = !!cfg.fast;
  }

  /** One structured-output request with server-side refusal fallbacks. */
  private async call<T>(a: CallArgs): Promise<T> {
    const response = await this.client.beta.messages.create(
      {
        model: this.model,
        max_tokens: a.maxTokens,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: a.system,
        messages: [{ role: 'user', content: a.user }],
        output_config: { effort: a.effort, format: { type: 'json_schema', schema: a.schema as Record<string, unknown> } },
        ...(this.fast ? { speed: 'fast' as const } : {}),
      },
      a.signal ? { signal: a.signal } : undefined,
    );
    if (response.stop_reason === 'refusal') throw new ClaudeRefusalError(response.stop_details?.category ?? null);
    if (response.stop_reason === 'max_tokens') throw new Error('Claude ran out of room for this answer');
    const text = response.content.map(b => (b.type === 'text' ? b.text : '')).join('');
    return JSON.parse(text) as T;
  }

  async translate(req: TranslateRequest, signal?: AbortSignal): Promise<TranslateResult[]> {
    if (!req.items.length) return [];
    const user = JSON.stringify({
      target_language: `${langName(req.target)} (${req.target})`,
      meeting: req.title ?? null,
      glossary: req.glossary ?? [],
      earlier_lines: (req.context ?? []).slice(-8),
      items: req.items.map(i => ({ id: i.id, ...(i.speaker ? { speaker: i.speaker } : {}), text: i.text })),
    });
    const out = await this.call<{ items: { id: string; lang: string; langs: string[]; confidence: number; translation: string }[] }>({
      system: TRANSLATE_SYSTEM, user, schema: TRANSLATE_SCHEMA, effort: 'low', maxTokens: 8000, ...(signal ? { signal } : {}),
    });
    const wanted = new Set(req.items.map(i => i.id));
    return (out.items ?? [])
      .filter(r => r && wanted.has(String(r.id)) && typeof r.translation === 'string')
      .map(r => ({
        id: String(r.id), translation: r.translation.slice(0, 4000), lang: normLang(r.lang),
        langs: [...new Set((r.langs ?? []).map(l => normLang(l)).filter((l): l is LangCode => !!l))],
        confidence: typeof r.confidence === 'number' ? Math.min(1, Math.max(0, r.confidence)) : null,
      }));
  }

  async summarize(req: ClarityRequest, signal?: AbortSignal): Promise<ClarityResult> {
    const transcript = req.lines.map(l => `[${l.id}] ${l.speaker}: ${l.text}`).join('\n');
    const user = [
      `Output language: ${langName(req.lang)} (${req.lang})`,
      `Person using Bibbly: ${req.me}`,
      `Meeting date: ${new Date(req.startedAt).toDateString()}`,
      req.title ? `Working title: ${req.title}` : '',
      req.final ? 'The meeting has ended. Write the final notes.' : 'The meeting is still going. Write the notes so far.',
      '',
      'Transcript:',
      transcript.length > 180_000 ? transcript.slice(-180_000) : transcript,
    ].filter(Boolean).join('\n');
    const o = await this.call<{
      title: string; summary: string[]; decisions: string[];
      actions: { owner: string; owner_is_me: boolean; task: string; due_date: string | null; due_time: string | null; line_id: string | null }[];
      followup: { title: string; date: string | null; time: string | null; duration_min: number } | null;
    }>({ system: CLARITY_SYSTEM, user, schema: CLARITY_SCHEMA, effort: req.final ? 'high' : 'medium', maxTokens: 16000, ...(signal ? { signal } : {}) });

    const item = (s: string): ClarityItem => ({ src: req.lang, text: { [req.lang]: s.slice(0, 600) } });
    const actions: ActionItem[] = (o.actions ?? []).filter(a => a?.task).slice(0, 20).map(a => ({
      ...item(a.task), id: uid('a_'), owner: String(a.owner ?? '').slice(0, 60), ownerIsMe: !!a.owner_is_me,
      due: parseDateTime(a.due_date, a.due_time), ...(a.line_id ? { lineId: a.line_id } : {}),
    }));
    const clarity: Clarity = {
      summary: (o.summary ?? []).filter(Boolean).slice(0, 6).map(item),
      decisions: (o.decisions ?? []).filter(Boolean).slice(0, 10).map(item),
      actions,
      followup: o.followup?.title ? { ...item(o.followup.title), when: parseDateTime(o.followup.date, o.followup.time ?? '10:00'), durationMin: Math.max(15, Math.min(240, o.followup.duration_min || 30)) } : null,
      updatedAt: Date.now(),
    };
    return { title: (o.title || req.title || 'Meeting').slice(0, 120), clarity };
  }

  async refine(text: string, now: number, signal?: AbortSignal): Promise<RefinedTask | null> {
    const d = new Date(now);
    const o = await this.call<{ title: string; date: string | null; time: string | null; remind: boolean; list: TaskList }>({
      system: TASK_SYSTEM,
      user: `Current date and time: ${d.toDateString()} ${d.toTimeString().slice(0, 5)}\nTo-do: ${text.slice(0, 500)}`,
      schema: TASK_SCHEMA, effort: 'low', maxTokens: 2000, ...(signal ? { signal } : {}),
    });
    if (!o?.title) return null;
    const due = parseDateTime(o.date, o.time);
    return { title: o.title.slice(0, 200), due, remind: !!o.remind || (due !== null && !!o.time), list: (['Work', 'Personal', 'Home'] as const).includes(o.list) ? o.list : 'Personal' };
  }
}

/** Maps SDK errors to short messages people can act on. */
export function describeClaudeError(err: unknown): string {
  if (err instanceof ClaudeRefusalError) return 'Claude declined to translate this line.';
  if (err instanceof Anthropic.AuthenticationError) return 'Your Anthropic API key was rejected. Check it in Settings.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key can’t use that model. Pick another model in Settings.';
  if (err instanceof Anthropic.RateLimitError) return 'Claude is busy. Bibbly will catch up in a moment.';
  if (err instanceof Anthropic.APIConnectionError) return 'Can’t reach Claude. Check your internet connection.';
  if (err instanceof Anthropic.APIError) return `Claude returned an error (${err.status ?? 'unknown'}).`;
  return err instanceof Error ? err.message : 'Something went wrong.';
}
