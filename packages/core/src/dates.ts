export const DAY_MS = 86_400_000;

export const startOfDay = (d: Date | number): Date => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d: Date | number, n: number): Date => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const atTime = (d: Date | number, hhmm: string): Date => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  const x = new Date(d);
  x.setHours(h, m, 0, 0);
  return x;
};
/** Monday of the week containing d. */
export const weekStart = (d: Date | number): Date => { const x = startOfDay(d); return addDays(x, -((x.getDay() + 6) % 7)); };
export const pad2 = (n: number): string => String(n).padStart(2, '0');
export const isoDay = (d: Date | number): string => { const x = new Date(d); return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`; };
export const hasTime = (d: Date | number): boolean => { const x = new Date(d); return x.getHours() + x.getMinutes() > 0; };
export const dayDiff = (d: Date | number, now: Date | number = Date.now()): number =>
  Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / DAY_MS);

/** "0:42", "12:05" */
export const fmtClock = (sec: number): string => { const s = Math.max(0, Math.floor(sec)); return `${Math.floor(s / 60)}:${pad2(s % 60)}`; };
/** "00:00:42" */
export const fmtStamp = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
};

/** Relative due-date rules used by agreed action items. */
export type DueRule =
  | { days: number; time?: string }
  | { weekday: 'fri' | 'sun'; time?: string }
  | { nextWeek: number; time?: string } // 1 = Monday ... 7 = Sunday of next week
  | { nextMonday: true; time?: string };

export function dueFrom(base: Date | number, rule: DueRule): Date {
  const b = startOfDay(base);
  let d: Date;
  if ('days' in rule) d = addDays(b, rule.days);
  else if ('weekday' in rule) {
    const wd = b.getDay();
    d = rule.weekday === 'fri' ? addDays(b, wd <= 5 ? 5 - wd : 6) : addDays(b, (7 - wd) % 7);
  } else if ('nextWeek' in rule) d = addDays(weekStart(b), 7 + (rule.nextWeek - 1));
  else { const wd = b.getDay(); d = addDays(b, ((8 - wd) % 7) || 7); }
  return rule.time ? atTime(d, rule.time) : d;
}

/** Parses "YYYY-MM-DD" plus optional "HH:MM" from model output; null when invalid. */
export function parseDateTime(date: unknown, time?: unknown): number | null {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return (typeof time === 'string' && /^\d{1,2}:\d{2}$/.test(time) ? atTime(d, time) : d).getTime();
}
