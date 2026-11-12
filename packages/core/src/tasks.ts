import { addDays, atTime, pad2, startOfDay, weekStart } from './dates.js';
import type { TaskList } from './types.js';

export interface QuickTask {
  title: string;
  /** Epoch milliseconds or null. */
  due: number | null;
  remind: boolean;
  list: TaskList;
}

const WORK = /\b(deck|client|meeting|review|report|invoice|email|send|supplier|launch|agenda|proposal|quote|pricing|call with)\b/i;
const HOME = /\b(plants|groceries|laundry|clean|rent|bins|kitchen|repair)\b/i;

/**
 * Parses quick-add text such as "Send deck to Li Wei tomorrow 3pm #work"
 * or "remind me to call Mom tonight". English only; other languages are
 * refined by Claude (see llm/tasks.ts).
 */
export function parseQuickTask(text: string, now: Date = new Date()): QuickTask {
  let s = ` ${String(text ?? '').trim()} `;
  let remind = false;
  let due: Date | null = null;
  let time: string | null = null;
  let list: TaskList | null = null;
  const today = startOfDay(now);

  s = s.replace(/\s#(work|personal|home)\b/i, (_m, l: string) => { list = (l[0]!.toUpperCase() + l.slice(1).toLowerCase()) as TaskList; return ' '; });
  s = s.replace(/^\s*(remind me to|remind me|reminder:?)\s+/i, () => { remind = true; return ' '; });
  s = s.replace(/\s(?:at\s)?(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/i, (_m, h: string, m: string | undefined, ap: string) => {
    const H = (Number(h) % 12) + (ap.toLowerCase() === 'pm' ? 12 : 0);
    time = `${pad2(H)}:${m ?? '00'}`;
    return ' ';
  });
  if (!time) s = s.replace(/\sat\s(\d{1,2}):(\d{2})\b/i, (_m, h: string, m: string) => { time = `${pad2(Math.min(23, Number(h)))}:${m}`; return ' '; });
  s = s.replace(/\s(?:at\s)?noon\b/i, () => { time = '12:00'; return ' '; });
  s = s.replace(/\stonight\b/i, () => { due = today; time = time ?? '20:00'; return ' '; });
  s = s.replace(/\stoday\b/i, () => { due = today; return ' '; });
  s = s.replace(/\s(tomorrow|tmrw|tmr)\b/i, () => { due = addDays(today, 1); return ' '; });
  s = s.replace(/\sin\s(\d{1,2})\sdays?\b/i, (_m, n: string) => { due = addDays(today, Number(n)); return ' '; });
  s = s.replace(/\s(?:on\s|by\s)?(next\s)?(mon|tue|wed|thu|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?\b/i, (_m, nx: string | undefined, wd: string) => {
    const idx = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(wd.toLowerCase());
    if (nx) due = addDays(weekStart(today), 7 + ((idx + 6) % 7));
    else due = addDays(today, ((idx - today.getDay() + 7) % 7) || 7);
    return ' ';
  });

  const t = time as string | null;
  if (t && !due) {
    const [h, m] = t.split(':').map(Number) as [number, number];
    due = h * 60 + m > now.getHours() * 60 + now.getMinutes() ? today : addDays(today, 1);
  }
  if (t) remind = true;

  let title = s.replace(/\s+/g, ' ').trim().replace(/^(to|and)\s+/i, '');
  title = title ? title[0]!.toUpperCase() + title.slice(1) : String(text ?? '').trim();
  const finalList: TaskList = list ?? (WORK.test(title) ? 'Work' : HOME.test(title) ? 'Home' : 'Personal');
  const d = due as Date | null;
  return { title, due: d ? (t ? atTime(d, t) : d).getTime() : null, remind, list: finalList };
}
