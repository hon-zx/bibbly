/** Google Calendar v3, Google Tasks v1 and Google Drive v3 (notes as Google Docs). */
import type { Note } from '@bibbly/core';
import { jwtClaims } from '../http.js';
import { noteHtml, noteModel } from '../format.js';
import type { CalendarApi, EventInput, NotesApi, NoteTarget, Profile, PublishOptions, RemoteEvent, RemoteTask, TaskApi, TaskInput, TokenSet } from '../types.js';
import { clip, detectPlatform, findMeetingUrl, localDay, localMidnight, randomId } from '../util.js';
import type { ApiCtx } from './ctx.js';

interface GEvent {
  id: string; status?: string; summary?: string; description?: string; location?: string; htmlLink?: string;
  start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
  hangoutLink?: string; updated?: string; etag?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[]; conferenceSolution?: { key?: { type?: string } } };
  attendees?: { email?: string; displayName?: string; self?: boolean; resource?: boolean }[];
}

function toRemoteEvent(e: GEvent): RemoteEvent | null {
  if (e.status === 'cancelled' || !e.start || !e.end) return null;
  const allDay = !!e.start.date;
  const start = allDay ? localMidnight(e.start.date!) : Date.parse(e.start.dateTime ?? '');
  const end = allDay ? localMidnight(e.end.date!) : Date.parse(e.end.dateTime ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const meetUrl = e.hangoutLink ?? e.conferenceData?.entryPoints?.find(p => p.entryPointType === 'video')?.uri ?? findMeetingUrl(e.location, e.description);
  const attendees = (e.attendees ?? []).filter(a => !a.self && !a.resource).map(a => a.displayName ?? a.email ?? '').filter(Boolean).join(', ');
  return {
    id: e.id, title: e.summary?.trim() || '(No title)', start, end, allDay,
    ...(e.location ? { location: e.location } : {}), ...(e.description ? { description: clip(e.description, 4000) } : {}),
    ...(meetUrl ? { meetUrl } : {}), ...(attendees ? { attendees } : {}), ...(e.htmlLink ? { url: e.htmlLink } : {}),
    platform: detectPlatform({ meetUrl, location: e.location, description: e.description, hint: e.conferenceData?.conferenceSolution?.key?.type }),
    version: e.etag ?? e.updated ?? '',
  };
}

function eventBody(e: EventInput, create: boolean): Record<string, unknown> {
  return {
    summary: e.title,
    description: e.description ?? '',
    ...(e.location !== undefined ? { location: e.location } : {}),
    start: { dateTime: new Date(e.start).toISOString() },
    end: { dateTime: new Date(e.end).toISOString() },
    ...(create && e.addMeeting && e.platform === 'meet'
      ? { conferenceData: { createRequest: { requestId: randomId(20), conferenceSolutionKey: { type: 'hangoutsMeet' } } } }
      : {}),
  };
}

const cal = (ctx: ApiCtx, calendarId: string, path = '') => `${ctx.ep.googleCalendar}/calendars/${encodeURIComponent(calendarId)}${path}`;

export function googleCalendar(ctx: ApiCtx): CalendarApi {
  return {
    async primaryCalendar() {
      const c = await ctx.http.request<{ id: string; summary?: string }>({ url: cal(ctx, 'primary'), auth: ctx.auth });
      return { id: c.id ?? 'primary', name: c.summary ?? 'Calendar' };
    },
    async listEvents(calendarId, from, to) {
      const out: RemoteEvent[] = [];
      let pageToken: string | undefined;
      do {
        const page = await ctx.http.request<{ items?: GEvent[]; nextPageToken?: string }>({
          url: cal(ctx, calendarId, '/events'), auth: ctx.auth,
          query: { timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 250, pageToken },
        });
        for (const e of page.items ?? []) { const r = toRemoteEvent(e); if (r) out.push(r); }
        pageToken = page.nextPageToken;
      } while (pageToken && out.length < 2000);
      return out;
    },
    async createEvent(calendarId, e) {
      const created = await ctx.http.request<GEvent>({
        method: 'POST', url: cal(ctx, calendarId, '/events'), auth: ctx.auth, json: eventBody(e, true),
        query: e.addMeeting && e.platform === 'meet' ? { conferenceDataVersion: 1 } : undefined,
      });
      return toRemoteEvent(created)!;
    },
    async updateEvent(calendarId, id, e) {
      const updated = await ctx.http.request<GEvent>({ method: 'PATCH', url: cal(ctx, calendarId, `/events/${encodeURIComponent(id)}`), auth: ctx.auth, json: eventBody(e, false) });
      return toRemoteEvent(updated)!;
    },
    async deleteEvent(calendarId, id) {
      try {
        await ctx.http.request({ method: 'DELETE', url: cal(ctx, calendarId, `/events/${encodeURIComponent(id)}`), auth: ctx.auth, expect: 'none' });
      } catch (err) {
        if ((err as { status?: number }).status !== 410 && (err as { status?: number }).status !== 404) throw err; // already gone
      }
    },
  };
}

interface GTask { id: string; title?: string; notes?: string; status?: string; due?: string; completed?: string; updated?: string; deleted?: boolean; webViewLink?: string }

function toRemoteTask(t: GTask): RemoteTask {
  return {
    id: t.id, title: t.title ?? '', ...(t.notes ? { notes: t.notes } : {}),
    // Google Tasks keeps only the date of a due time.
    due: t.due ? localMidnight(t.due.slice(0, 10)) : null, dueHasTime: false,
    completed: t.status === 'completed', completedAt: t.completed ? Date.parse(t.completed) : null,
    updated: t.updated ? Date.parse(t.updated) : 0, version: t.updated ?? '', ...(t.webViewLink ? { url: t.webViewLink } : {}),
  };
}

function taskBody(t: TaskInput, create: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { title: t.title, notes: t.notes ?? '', status: t.completed ? 'completed' : 'needsAction' };
  if (t.due != null) body.due = `${localDay(t.due)}T00:00:00.000Z`;
  else if (!create) body.due = null;
  if (!t.completed && !create) body.completed = null;
  return body;
}

export function googleTasks(ctx: ApiCtx): TaskApi {
  const base = ctx.ep.googleTasks;
  return {
    async findOrCreateList(name) {
      const lists = await ctx.http.request<{ items?: { id: string; title: string }[] }>({ url: `${base}/users/@me/lists`, auth: ctx.auth, query: { maxResults: 100 } });
      const found = (lists.items ?? []).find(l => l.title.trim().toLowerCase() === name.trim().toLowerCase());
      if (found) return { id: found.id, name: found.title };
      const made = await ctx.http.request<{ id: string; title: string }>({ method: 'POST', url: `${base}/users/@me/lists`, auth: ctx.auth, json: { title: name } });
      return { id: made.id, name: made.title };
    },
    async listTasks(listId) {
      const out: RemoteTask[] = [];
      let pageToken: string | undefined;
      do {
        const page = await ctx.http.request<{ items?: GTask[]; nextPageToken?: string }>({
          url: `${base}/lists/${encodeURIComponent(listId)}/tasks`, auth: ctx.auth,
          query: { showCompleted: true, showHidden: true, maxResults: 100, pageToken },
        });
        for (const t of page.items ?? []) if (!t.deleted) out.push(toRemoteTask(t));
        pageToken = page.nextPageToken;
      } while (pageToken && out.length < 2000);
      return out;
    },
    async createTask(listId, t) {
      return toRemoteTask(await ctx.http.request<GTask>({ method: 'POST', url: `${base}/lists/${encodeURIComponent(listId)}/tasks`, auth: ctx.auth, json: taskBody(t, true) }));
    },
    async updateTask(listId, id, t) {
      return toRemoteTask(await ctx.http.request<GTask>({ method: 'PATCH', url: `${base}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(id)}`, auth: ctx.auth, json: taskBody(t, false) }));
    },
    async deleteTask(listId, id) {
      try {
        await ctx.http.request({ method: 'DELETE', url: `${base}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(id)}`, auth: ctx.auth, expect: 'none' });
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err;
      }
    },
  };
}

const FOLDER = 'Bibbly notes';
const DOC_MIME = 'application/vnd.google-apps.document';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Notes become Google Docs in a "Bibbly notes" folder (drive.file: Bibbly only sees files it made). */
export function googleDrive(ctx: ApiCtx): NotesApi {
  async function folderId(): Promise<string> {
    const q = `name = '${FOLDER}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const found = await ctx.http.request<{ files?: { id: string }[] }>({ url: `${ctx.ep.googleDrive}/files`, auth: ctx.auth, query: { q, fields: 'files(id)', pageSize: 1 } });
    if (found.files?.[0]) return found.files[0].id;
    const made = await ctx.http.request<{ id: string }>({ method: 'POST', url: `${ctx.ep.googleDrive}/files`, auth: ctx.auth, json: { name: FOLDER, mimeType: FOLDER_MIME }, query: { fields: 'id' } });
    return made.id;
  }
  return {
    async listTargets(): Promise<NoteTarget[]> {
      return [{ id: 'bibbly-folder', name: `${FOLDER} folder`, detail: 'In your Google Drive' }];
    },
    async publish(_target, note: Note, opts: PublishOptions) {
      const m = noteModel(note, opts);
      const parent = await folderId();
      const boundary = `bibbly${randomId(12)}`;
      const meta = { name: m.title, mimeType: DOC_MIME, parents: [parent] };
      const body = [
        `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(meta),
        `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', '', `<html><body>${noteHtml(m)}</body></html>`,
        `--${boundary}--`, '',
      ].join('\r\n');
      const file = await ctx.http.request<{ id: string; webViewLink?: string }>({
        method: 'POST', url: `${ctx.ep.googleDriveUpload}/files`, auth: ctx.auth, body,
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        query: { uploadType: 'multipart', fields: 'id,webViewLink' },
      });
      return { url: file.webViewLink ?? `https://docs.google.com/document/d/${file.id}/edit` };
    },
  };
}

export async function googleProfile(tokens: TokenSet, ctx: ApiCtx): Promise<Profile> {
  const claims = jwtClaims(tokens.extra?.id_token);
  if (typeof claims.email === 'string') return { id: claims.email, label: claims.email };
  const me = await ctx.http.request<{ email?: string; sub?: string; name?: string }>({ url: ctx.ep.googleUserinfo, auth: ctx.auth });
  return { id: me.email ?? me.sub ?? 'google', label: me.email ?? me.name ?? 'Google account' };
}
