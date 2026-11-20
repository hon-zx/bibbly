/** Microsoft Graph: Outlook Calendar, Microsoft To Do and Teams channel messages. */
import type { Note } from '@bibbly/core';
import { jwtClaims } from '../http.js';
import { noteHtml, noteModel } from '../format.js';
import type { CalendarApi, EventInput, NotesApi, NoteTarget, Profile, PublishOptions, RemoteEvent, RemoteTask, TaskApi, TaskInput, TokenSet } from '../types.js';
import { clip, detectPlatform, findMeetingUrl, isoNoZ, localDay, localMidnight, parseUtc } from '../util.js';
import type { ApiCtx } from './ctx.js';

interface GraphPage<T> { value?: T[]; '@odata.nextLink'?: string }

async function all<T>(ctx: ApiCtx, url: string, query?: Record<string, string | number>, headers?: Record<string, string>, cap = 2000): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = url;
  let first = true;
  while (next && out.length < cap) {
    const page: GraphPage<T> = await ctx.http.request<GraphPage<T>>({ url: next, auth: ctx.auth, ...(first && query ? { query } : {}), ...(headers ? { headers } : {}) });
    out.push(...(page.value ?? []));
    next = page['@odata.nextLink'];
    first = false;
  }
  return out;
}

interface MEvent {
  id: string; subject?: string; bodyPreview?: string; isAllDay?: boolean; isCancelled?: boolean; webLink?: string;
  start?: { dateTime: string; timeZone?: string }; end?: { dateTime: string; timeZone?: string };
  location?: { displayName?: string }; isOnlineMeeting?: boolean; onlineMeetingProvider?: string;
  onlineMeeting?: { joinUrl?: string } | null; onlineMeetingUrl?: string | null;
  changeKey?: string; lastModifiedDateTime?: string;
  attendees?: { emailAddress?: { name?: string; address?: string } }[];
}

const UTC = { Prefer: 'outlook.timezone="UTC"' };

function toRemoteEvent(e: MEvent): RemoteEvent | null {
  if (e.isCancelled || !e.start || !e.end) return null;
  const allDay = !!e.isAllDay;
  const start = allDay ? localMidnight(e.start.dateTime) : parseUtc(e.start.dateTime);
  const end = allDay ? localMidnight(e.end.dateTime) : parseUtc(e.end.dateTime);
  const location = e.location?.displayName || undefined;
  const meetUrl = e.onlineMeeting?.joinUrl ?? e.onlineMeetingUrl ?? findMeetingUrl(location, e.bodyPreview);
  const attendees = (e.attendees ?? []).map(a => a.emailAddress?.name ?? a.emailAddress?.address ?? '').filter(Boolean).join(', ');
  return {
    id: e.id, title: e.subject?.trim() || '(No title)', start, end, allDay,
    ...(location ? { location } : {}), ...(e.bodyPreview ? { description: clip(e.bodyPreview, 4000) } : {}),
    ...(meetUrl ? { meetUrl } : {}), ...(attendees ? { attendees } : {}), ...(e.webLink ? { url: e.webLink } : {}),
    platform: detectPlatform({ meetUrl, location, description: e.bodyPreview, hint: e.onlineMeetingProvider }),
    version: e.changeKey ?? e.lastModifiedDateTime ?? '',
  };
}

function eventBody(e: EventInput, create: boolean): Record<string, unknown> {
  return {
    subject: e.title,
    body: { contentType: 'text', content: e.description ?? '' },
    start: { dateTime: isoNoZ(e.start), timeZone: 'UTC' },
    end: { dateTime: isoNoZ(e.end), timeZone: 'UTC' },
    ...(e.location !== undefined ? { location: { displayName: e.location } } : {}),
    ...(create && e.addMeeting && e.platform === 'teams' ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } : {}),
  };
}

const calPath = (ctx: ApiCtx, calendarId: string) => (calendarId === 'primary' || !calendarId ? `${ctx.ep.graph}/me/calendar` : `${ctx.ep.graph}/me/calendars/${encodeURIComponent(calendarId)}`);
const EVENT_FIELDS = 'id,subject,bodyPreview,isAllDay,isCancelled,webLink,start,end,location,isOnlineMeeting,onlineMeetingProvider,onlineMeeting,onlineMeetingUrl,changeKey,lastModifiedDateTime,attendees';

export function outlookCalendar(ctx: ApiCtx): CalendarApi {
  return {
    async primaryCalendar() {
      const c = await ctx.http.request<{ id: string; name?: string }>({ url: `${ctx.ep.graph}/me/calendar`, auth: ctx.auth });
      return { id: c.id, name: c.name ?? 'Calendar' };
    },
    async listEvents(calendarId, from, to) {
      const items = await all<MEvent>(ctx, `${calPath(ctx, calendarId)}/calendarView`,
        { startDateTime: new Date(from).toISOString(), endDateTime: new Date(to).toISOString(), $top: 200, $select: EVENT_FIELDS, $orderby: 'start/dateTime' }, UTC);
      return items.map(toRemoteEvent).filter((e): e is RemoteEvent => !!e);
    },
    async createEvent(calendarId, e) {
      return toRemoteEvent(await ctx.http.request<MEvent>({ method: 'POST', url: `${calPath(ctx, calendarId)}/events`, auth: ctx.auth, json: eventBody(e, true), headers: UTC }))!;
    },
    async updateEvent(_calendarId, id, e) {
      return toRemoteEvent(await ctx.http.request<MEvent>({ method: 'PATCH', url: `${ctx.ep.graph}/me/events/${encodeURIComponent(id)}`, auth: ctx.auth, json: eventBody(e, false), headers: UTC }))!;
    },
    async deleteEvent(_calendarId, id) {
      try {
        await ctx.http.request({ method: 'DELETE', url: `${ctx.ep.graph}/me/events/${encodeURIComponent(id)}`, auth: ctx.auth, expect: 'none' });
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err;
      }
    },
  };
}

interface MTask {
  id: string; title?: string; status?: string; body?: { content?: string };
  dueDateTime?: { dateTime: string; timeZone?: string } | null; completedDateTime?: { dateTime: string } | null;
  isReminderOn?: boolean; reminderDateTime?: { dateTime: string; timeZone?: string } | null; lastModifiedDateTime?: string;
}

function toRemoteTask(t: MTask): RemoteTask {
  const reminder = t.isReminderOn && t.reminderDateTime ? parseUtc(t.reminderDateTime.dateTime) : null;
  const due = reminder ?? (t.dueDateTime ? localMidnight(t.dueDateTime.dateTime.slice(0, 10)) : null);
  const notes = t.body?.content?.trim();
  return {
    id: t.id, title: t.title ?? '', ...(notes ? { notes } : {}), due, dueHasTime: reminder != null,
    completed: t.status === 'completed', completedAt: t.completedDateTime ? parseUtc(t.completedDateTime.dateTime) : null,
    updated: t.lastModifiedDateTime ? Date.parse(t.lastModifiedDateTime) : 0, version: t.lastModifiedDateTime ?? '',
  };
}

function taskBody(t: TaskInput): Record<string, unknown> {
  const remindAt = t.remind && t.due != null && t.dueHasTime;
  return {
    title: t.title,
    body: { contentType: 'text', content: t.notes ?? '' },
    status: t.completed ? 'completed' : 'notStarted',
    dueDateTime: t.due != null ? { dateTime: `${localDay(t.due)}T00:00:00`, timeZone: 'UTC' } : null,
    isReminderOn: !!remindAt,
    reminderDateTime: remindAt ? { dateTime: isoNoZ(t.due!), timeZone: 'UTC' } : null,
  };
}

export function microsoftTodo(ctx: ApiCtx): TaskApi {
  const lists = `${ctx.ep.graph}/me/todo/lists`;
  return {
    async findOrCreateList(name) {
      const found = (await all<{ id: string; displayName: string }>(ctx, lists)).find(l => l.displayName.trim().toLowerCase() === name.trim().toLowerCase());
      if (found) return { id: found.id, name: found.displayName };
      const made = await ctx.http.request<{ id: string; displayName: string }>({ method: 'POST', url: lists, auth: ctx.auth, json: { displayName: name } });
      return { id: made.id, name: made.displayName };
    },
    async listTasks(listId) {
      return (await all<MTask>(ctx, `${lists}/${encodeURIComponent(listId)}/tasks`, { $top: 100 })).map(toRemoteTask);
    },
    async createTask(listId, t) {
      return toRemoteTask(await ctx.http.request<MTask>({ method: 'POST', url: `${lists}/${encodeURIComponent(listId)}/tasks`, auth: ctx.auth, json: taskBody(t) }));
    },
    async updateTask(listId, id, t) {
      return toRemoteTask(await ctx.http.request<MTask>({ method: 'PATCH', url: `${lists}/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(id)}`, auth: ctx.auth, json: taskBody(t) }));
    },
    async deleteTask(listId, id) {
      try {
        await ctx.http.request({ method: 'DELETE', url: `${lists}/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(id)}`, auth: ctx.auth, expect: 'none' });
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err;
      }
    },
  };
}

/** Notes posted to a Teams channel (work and school accounts). */
export function teamsChannels(ctx: ApiCtx): NotesApi {
  return {
    async listTargets(): Promise<NoteTarget[]> {
      const teams = (await all<{ id: string; displayName: string }>(ctx, `${ctx.ep.graph}/me/joinedTeams`)).slice(0, 25);
      const out: NoteTarget[] = [];
      for (const t of teams) {
        const channels = await all<{ id: string; displayName: string }>(ctx, `${ctx.ep.graph}/teams/${encodeURIComponent(t.id)}/channels`);
        for (const c of channels) out.push({ id: `${t.id}|${c.id}`, name: `${t.displayName} › ${c.displayName}`, detail: 'Teams channel' });
      }
      return out;
    },
    async publish(target, note: Note, opts: PublishOptions) {
      const [teamId, channelId] = target.id.split('|');
      if (!teamId || !channelId) throw new Error('Pick a Teams channel for notes in Settings.');
      const m = noteModel(note, opts);
      const msg = await ctx.http.request<{ id: string; webUrl?: string }>({
        method: 'POST', url: `${ctx.ep.graph}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`, auth: ctx.auth,
        json: { subject: m.title, body: { contentType: 'html', content: noteHtml(m, { maxRows: 40, heading: false }) } },
      });
      return msg.webUrl ? { url: msg.webUrl } : {};
    },
  };
}

export async function microsoftProfile(tokens: TokenSet, ctx: ApiCtx): Promise<Profile> {
  const claims = jwtClaims(tokens.extra?.id_token);
  const email = (claims.preferred_username ?? claims.email) as string | undefined;
  if (email) return { id: String(claims.oid ?? email), label: email };
  const me = await ctx.http.request<{ id: string; mail?: string; userPrincipalName?: string; displayName?: string }>({ url: `${ctx.ep.graph}/me`, auth: ctx.auth });
  return { id: me.id, label: me.mail ?? me.userPrincipalName ?? me.displayName ?? 'Microsoft account' };
}
