/**
 * Calendar sync between Bibbly and one calendar in a connected app.
 *
 * Events created in the app appear in Bibbly; the app owns their title and
 * time, and Bibbly keeps its own details (Bibbly joins, languages, notes).
 * Events created in Bibbly, such as follow-ups from meeting notes, are saved
 * to the calendar chosen for that; edits and deletions on either side follow.
 * Only a window around today is compared, so old history is never touched.
 */
import type { CalendarEvent } from '@bibbly/core';
import type { CalendarApi, ConnectedAccount, EventInput, RemoteEvent, SyncLink } from '../types.js';
import { hash } from '../util.js';

export interface CalendarSyncOptions { pastDays?: number; futureDays?: number; /** This calendar receives events made in Bibbly. */ push: boolean }
export interface CalendarSyncResult { events: CalendarEvent[]; links: SyncLink[]; pulled: number; pushed: number; removed: number }

const DAY = 86_400_000;
const ver = (e: CalendarEvent) => String(e.updatedAt ?? 0);
const MEETING_APPS = new Set(['meet', 'teams', 'lark']);

export function eventInput(e: CalendarEvent, create: boolean): EventInput {
  return {
    title: e.title, start: e.start, end: e.start + Math.max(5, e.durationMin) * 60_000, platform: e.platform,
    ...(e.description !== undefined ? { description: e.description } : e.prevNoteId ? { description: 'Follow-up from a meeting captured with Bibbly.' } : {}),
    ...(e.location !== undefined ? { location: e.location } : {}),
    addMeeting: create && MEETING_APPS.has(e.platform) && !e.meetUrl,
  };
}

function source(account: ConnectedAccount, calendarId: string, r: RemoteEvent, readOnly: boolean): NonNullable<CalendarEvent['source']> {
  return { provider: account.provider, accountId: account.id, calendarId, eventId: r.id, ...(r.url ? { url: r.url } : {}), ...(readOnly ? { readOnly } : {}) };
}

function remoteFields(r: RemoteEvent): Partial<CalendarEvent> {
  return {
    title: r.title, start: r.start, durationMin: Math.max(5, Math.round((r.end - r.start) / 60_000)), platform: r.platform, allDay: r.allDay,
    ...(r.meetUrl ? { meetUrl: r.meetUrl } : {}), ...(r.location ? { location: r.location } : {}),
    ...(r.description ? { description: r.description } : {}), ...(r.attendees ? { attendees: r.attendees } : {}),
  };
}

export async function syncCalendar(api: CalendarApi, account: ConnectedAccount, calendarId: string, events: CalendarEvent[], links: SyncLink[], now: number, opts: CalendarSyncOptions): Promise<CalendarSyncResult> {
  const from = now - (opts.pastDays ?? 1) * DAY;
  const to = now + (opts.futureDays ?? 30) * DAY;
  const remote = await api.listEvents(calendarId, from, to);
  const byId = new Map(remote.map(r => [r.id, r]));
  let out = [...events];
  const keep = links.filter(l => !(l.kind === 'event' && l.accountId === account.id));
  const mine = links.filter(l => l.kind === 'event' && l.accountId === account.id && l.container === calendarId);
  const otherAccounts = new Set(links.filter(l => l.kind === 'event' && l.accountId !== account.id).map(l => l.localId));
  const seenRemote = new Set<string>();
  const seenLocal = new Set<string>();
  let pulled = 0, pushed = 0, removed = 0;
  const put = (e: CalendarEvent) => { const i = out.findIndex(x => x.id === e.id); if (i >= 0) out[i] = e; else out.push(e); };
  const link = (e: CalendarEvent, r: RemoteEvent, origin: SyncLink['origin']): SyncLink => ({
    kind: 'event', accountId: account.id, localId: e.id, remoteId: r.id, container: calendarId, origin, localVersion: ver(e), remoteVersion: r.version, syncedAt: now,
  });
  const inWindow = (t: number) => t >= from && t <= to;

  for (const l of mine) {
    const L = out.find(e => e.id === l.localId);
    const R = byId.get(l.remoteId);
    if (R) seenRemote.add(R.id);
    if (L) seenLocal.add(L.id);
    if (!L && !R) continue;
    if (!R) {
      if (L && !inWindow(L.start)) { keep.push(l); continue; } // outside the window: nothing to compare
      // Deleted in the app. Keep a meeting that already has notes, without its calendar link.
      if (L) { if (L.noteId) { const { source: _gone, ...rest } = L; put(rest); } else out = out.filter(e => e.id !== L.id); removed++; }
      continue;
    }
    if (!L) {
      if (l.origin === 'local') { await api.deleteEvent(calendarId, R.id); removed++; }
      else { const e: CalendarEvent = { id: l.localId, bibblyJoins: false, ...(remoteFields(R) as Omit<CalendarEvent, 'id' | 'bibblyJoins'>), source: source(account, calendarId, R, true) }; out.push(e); keep.push(link(e, R, 'remote')); pulled++; }
      continue;
    }
    const localChanged = l.origin === 'local' && ver(L) !== l.localVersion;
    const remoteChanged = R.version !== l.remoteVersion;
    if (localChanged) {
      const u = await api.updateEvent(calendarId, R.id, eventInput(L, false));
      const e = { ...L, source: source(account, calendarId, u, false) };
      put(e); keep.push(link(e, u, 'local')); pushed++;
    } else if (remoteChanged) {
      const e = { ...L, ...remoteFields(R), source: source(account, calendarId, R, l.origin === 'remote') };
      put(e); keep.push(link(e, R, l.origin)); pulled++;
    } else {
      keep.push({ ...l, syncedAt: now });
    }
  }

  for (const R of remote) {
    if (seenRemote.has(R.id)) continue;
    // Saved from Bibbly before (same title and start): pair instead of duplicating.
    const twin = out.find(e => !e.source && !seenLocal.has(e.id) && e.title.trim() === R.title.trim() && Math.abs(e.start - R.start) < 60_000);
    if (twin) {
      const e = { ...twin, source: source(account, calendarId, R, false) };
      put(e); seenLocal.add(e.id); keep.push(link(e, R, 'local'));
      continue;
    }
    const e: CalendarEvent = { id: `${account.provider}-${hash(account.id, R.id)}`, bibblyJoins: false, ...(remoteFields(R) as Omit<CalendarEvent, 'id' | 'bibblyJoins'>), source: source(account, calendarId, R, true) };
    put(e); seenLocal.add(e.id); keep.push(link(e, R, 'remote')); pulled++;
  }

  if (opts.push) {
    for (const L of [...out]) {
      if (L.source || seenLocal.has(L.id) || otherAccounts.has(L.id) || L.start < now - 3_600_000) continue;
      const c = await api.createEvent(calendarId, eventInput(L, true));
      const e = { ...L, ...(c.meetUrl && !L.meetUrl ? { meetUrl: c.meetUrl } : {}), source: source(account, calendarId, c, false) };
      put(e); keep.push(link(e, c, 'local')); pushed++;
    }
  }
  return { events: out, links: keep, pulled, pushed, removed };
}
