/**
 * Puts a sync result back into the app's data without losing edits made while
 * the sync ran (a few seconds of network calls): items changed locally in the
 * meantime keep the local version (the next sync sends it), items added stay,
 * and items deleted stay deleted.
 */
import type { CalendarEvent, Task } from '@bibbly/core';
import type { SyncData } from './engine.js';

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

export function mergeAfterSync<T extends { id: string }>(before: T[], after: T[], current: T[], keep: (local: T, synced: T) => T): T[] {
  const was = new Map(before.map(x => [x.id, x]));
  const now = new Map(current.map(x => [x.id, x]));
  const out: T[] = [];
  for (const a of after) {
    const b = was.get(a.id);
    const c = now.get(a.id);
    if (b && !c) continue;
    out.push(b && c && !same(b, c) ? keep(c, a) : a);
  }
  const placed = new Set(out.map(x => x.id));
  for (const c of current) if (!placed.has(c.id) && !was.has(c.id)) out.push(c);
  return out;
}

/** Local edits win, but keep what the sync learned about where each item lives. */
const keepTask = (local: Task, synced: Task): Task => ({ ...local, ...(synced.synced ? { synced: synced.synced } : {}) });
const keepEvent = (local: CalendarEvent, synced: CalendarEvent): CalendarEvent =>
  ({ ...local, ...(synced.source ? { source: synced.source } : {}), ...(!local.meetUrl && synced.meetUrl ? { meetUrl: synced.meetUrl } : {}) });

/** `before` is what the sync started from, `after` what it returned, `current` the app's data now. */
export function applySyncResult(before: SyncData, after: SyncData, current: SyncData): SyncData {
  return {
    tasks: mergeAfterSync(before.tasks, after.tasks, current.tasks, keepTask),
    events: mergeAfterSync(before.events, after.events, current.events, keepEvent),
  };
}
