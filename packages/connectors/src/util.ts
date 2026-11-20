import type { Platform } from '@bibbly/core';

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date as YYYY-MM-DD. */
export const localDay = (ms: number): string => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** Local midnight of a YYYY-MM-DD date. */
export const localMidnight = (ymd: string): number => {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1).getTime();
};

/** ISO 8601 in UTC without the trailing Z, as Microsoft Graph wants with timeZone "UTC". */
export const isoNoZ = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '').replace(/Z$/, '');

/** Graph returns UTC times without a zone designator when asked for UTC. */
export const parseUtc = (dt: string): number => Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(dt) ? dt : `${dt}Z`);

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

/** First meeting link in some text (Zoom, Teams, Meet or Lark). */
export function findMeetingUrl(...texts: (string | undefined)[]): string | undefined {
  for (const t of texts) {
    for (const m of t?.match(URL_RE) ?? []) if (/zoom\.us|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|larksuite\.com|feishu\.cn/i.test(m)) return m;
  }
  return undefined;
}

/** Works out which meeting app an event uses from its links and location. */
export function detectPlatform(p: { meetUrl?: string; location?: string; description?: string; hint?: string }): Platform {
  const all = `${p.hint ?? ''} ${p.meetUrl ?? ''} ${p.location ?? ''} ${p.description ?? ''}`.toLowerCase();
  if (/hangoutsmeet|meet\.google\.com/.test(all)) return 'meet';
  if (/zoom\.us/.test(all)) return 'zoom';
  if (/teamsforbusiness|teams\.microsoft\.com|teams\.live\.com/.test(all)) return 'teams';
  if (/larksuite\.com|feishu\.cn|\bvc\b/.test(all)) return 'lark';
  return p.location?.trim() ? 'in-person' : 'other';
}

/** Short, stable hash for change detection where an app has no updated time. */
export function hash(...parts: unknown[]): string {
  let h = 2166136261;
  for (const ch of JSON.stringify(parts)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

export const clip = (s: string | undefined, max: number): string | undefined => (s && s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function randomId(len = 16): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += abc[Math.floor(Math.random() * abc.length)];
  return out;
}

/** Splits a string into pieces of at most `max` characters (Notion and Slack limits). */
export function chunkText(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out;
}

/** Byte length of a string in UTF-8. */
export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) { const cp = ch.codePointAt(0)!; n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4; }
  return n;
}
