/**
 * Lark (and Feishu): calendar, tasks and notes posted to a chat, with a user
 * access token. Beta: built from Lark's published API shapes; verify against
 * your tenant (see docs/connectors.md).
 */
import type { Note } from '@bibbly/core';
import { ConnectorError } from '../http.js';
import { larkPost, noteModel } from '../format.js';
import type { CalendarApi, EventInput, NotesApi, NoteTarget, Profile, PublishOptions, RemoteEvent, RemoteTask, TaskApi, TaskInput } from '../types.js';
import { clip, detectPlatform, findMeetingUrl, hash, localMidnight } from '../util.js';
import type { ApiCtx } from './ctx.js';

type LarkResp<T> = { code: number; msg?: string; data?: T };

async function call<T>(ctx: ApiCtx, method: string, path: string, opts: { json?: unknown; query?: Record<string, string | number | boolean | undefined> } = {}): Promise<T> {
  const res = await ctx.http.request<LarkResp<T>>({ method, url: `${ctx.ep.larkApi}${path}`, auth: ctx.auth, ...(opts.json !== undefined ? { json: opts.json } : {}), ...(opts.query ? { query: opts.query } : {}) });
  if (!res || res.code !== 0) throw new ConnectorError(`Lark said: ${res?.msg ?? 'unknown error'} (${res?.code})`, 'Lark', 200, String(res?.code ?? ''));
  return (res.data ?? {}) as T;
}

interface LTime { timestamp?: string; date?: string; timezone?: string }
interface LEvent { event_id: string; summary?: string; description?: string; status?: string; start_time?: LTime; end_time?: LTime; vchat?: { meeting_url?: string; vc_type?: string }; location?: { name?: string }; app_link?: string }

const larkTime = (t?: LTime): { ms: number; allDay: boolean } =>
  t?.timestamp ? { ms: Number(t.timestamp) * 1000, allDay: false } : t?.date ? { ms: localMidnight(t.date), allDay: true } : { ms: NaN, allDay: false };

function toRemoteEvent(e: LEvent): RemoteEvent | null {
  if (e.status === 'cancelled') return null;
  const s = larkTime(e.start_time), en = larkTime(e.end_time);
  if (!Number.isFinite(s.ms) || !Number.isFinite(en.ms)) return null;
  const location = e.location?.name || undefined;
  const meetUrl = e.vchat?.meeting_url || findMeetingUrl(location, e.description);
  return {
    id: e.event_id, title: e.summary?.trim() || '(No title)', start: s.ms, end: en.ms, allDay: s.allDay,
    ...(location ? { location } : {}), ...(e.description ? { description: clip(e.description, 4000) } : {}),
    ...(meetUrl ? { meetUrl } : {}), ...(e.app_link ? { url: e.app_link } : {}),
    platform: e.vchat?.vc_type === 'vc' ? 'lark' : detectPlatform({ meetUrl, location, description: e.description }),
    version: hash(e.summary, e.start_time, e.end_time, e.description, e.location, e.vchat),
  };
}

function eventBody(e: EventInput, create: boolean): Record<string, unknown> {
  return {
    summary: e.title, description: e.description ?? '',
    start_time: { timestamp: String(Math.floor(e.start / 1000)) }, end_time: { timestamp: String(Math.floor(e.end / 1000)) },
    ...(e.location ? { location: { name: e.location } } : {}),
    ...(create && e.addMeeting && e.platform === 'lark' ? { vchat: { vc_type: 'vc' } } : {}),
  };
}

export function larkCalendar(ctx: ApiCtx): CalendarApi {
  const events = (cid: string) => `/calendar/v4/calendars/${encodeURIComponent(cid)}/events`;
  return {
    async primaryCalendar() {
      const d = await call<{ calendars?: { calendar?: { calendar_id: string; summary?: string } }[] }>(ctx, 'POST', '/calendar/v4/calendars/primary', { json: {} });
      const c = d.calendars?.[0]?.calendar;
      if (!c) throw new ConnectorError('Lark did not return a primary calendar', 'Lark', 200, 'no_calendar');
      return { id: c.calendar_id, name: c.summary ?? 'Calendar' };
    },
    async listEvents(calendarId, from, to) {
      const out: RemoteEvent[] = [];
      let page: string | undefined;
      do {
        const d = await call<{ items?: LEvent[]; has_more?: boolean; page_token?: string }>(ctx, 'GET', events(calendarId), {
          query: { start_time: String(Math.floor(from / 1000)), end_time: String(Math.floor(to / 1000)), page_size: 500, page_token: page },
        });
        for (const e of d.items ?? []) { const r = toRemoteEvent(e); if (r) out.push(r); }
        page = d.has_more ? d.page_token : undefined;
      } while (page && out.length < 2000);
      return out;
    },
    async createEvent(calendarId, e) {
      const d = await call<{ event: LEvent }>(ctx, 'POST', events(calendarId), { json: eventBody(e, true) });
      return toRemoteEvent(d.event)!;
    },
    async updateEvent(calendarId, id, e) {
      const d = await call<{ event: LEvent }>(ctx, 'PATCH', `${events(calendarId)}/${encodeURIComponent(id)}`, { json: eventBody(e, false) });
      return toRemoteEvent(d.event)!;
    },
    async deleteEvent(calendarId, id) {
      await call(ctx, 'DELETE', `${events(calendarId)}/${encodeURIComponent(id)}`);
    },
  };
}

interface LTask { guid: string; summary?: string; description?: string; completed_at?: string; due?: { timestamp?: string; is_all_day?: boolean }; updated_at?: string; url?: string }

function toRemoteTask(t: LTask): RemoteTask {
  const due = t.due?.timestamp ? Number(t.due.timestamp) : null;
  const completedAt = t.completed_at && t.completed_at !== '0' ? Number(t.completed_at) : null;
  return {
    id: t.guid, title: t.summary ?? '', ...(t.description ? { notes: t.description } : {}),
    due, dueHasTime: due != null && !t.due?.is_all_day, completed: completedAt != null, completedAt,
    updated: t.updated_at ? Number(t.updated_at) : 0,
    version: t.updated_at ?? hash(t.summary, t.description, t.due, t.completed_at), ...(t.url ? { url: t.url } : {}),
  };
}

function taskFields(t: TaskInput, now: number): Record<string, unknown> {
  return {
    summary: t.title, description: t.notes ?? '',
    ...(t.due != null ? { due: { timestamp: String(t.due), is_all_day: !t.dueHasTime } } : {}),
    completed_at: t.completed ? String(now) : '0',
  };
}

export function larkTasks(ctx: ApiCtx): TaskApi {
  const now = () => (ctx.now ?? Date.now)();
  return {
    async findOrCreateList(name) {
      const d = await call<{ items?: { guid: string; name: string }[] }>(ctx, 'GET', '/task/v2/tasklists', { query: { page_size: 100 } });
      const found = (d.items ?? []).find(l => l.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (found) return { id: found.guid, name: found.name };
      const made = await call<{ tasklist: { guid: string; name: string } }>(ctx, 'POST', '/task/v2/tasklists', { json: { name } });
      return { id: made.tasklist.guid, name: made.tasklist.name };
    },
    async listTasks(listId) {
      const out: RemoteTask[] = [];
      let page: string | undefined;
      do {
        const d = await call<{ items?: LTask[]; has_more?: boolean; page_token?: string }>(ctx, 'GET', `/task/v2/tasklists/${encodeURIComponent(listId)}/tasks`, { query: { page_size: 100, page_token: page } });
        out.push(...(d.items ?? []).map(toRemoteTask));
        page = d.has_more ? d.page_token : undefined;
      } while (page && out.length < 2000);
      return out;
    },
    async createTask(listId, t) {
      const d = await call<{ task: LTask }>(ctx, 'POST', '/task/v2/tasks', { json: { ...taskFields(t, now()), tasklists: [{ tasklist_guid: listId }] } });
      return toRemoteTask(d.task);
    },
    async updateTask(_listId, id, t) {
      const d = await call<{ task: LTask }>(ctx, 'PATCH', `/task/v2/tasks/${encodeURIComponent(id)}`, {
        json: { task: taskFields(t, now()), update_fields: ['summary', 'description', 'due', 'completed_at'] },
      });
      return toRemoteTask(d.task);
    },
    async deleteTask(_listId, id) {
      await call(ctx, 'DELETE', `/task/v2/tasks/${encodeURIComponent(id)}`);
    },
  };
}

export function larkChats(ctx: ApiCtx): NotesApi {
  return {
    async listTargets(): Promise<NoteTarget[]> {
      const out: NoteTarget[] = [];
      let page: string | undefined;
      do {
        const d = await call<{ items?: { chat_id: string; name?: string }[]; has_more?: boolean; page_token?: string }>(ctx, 'GET', '/im/v1/chats', { query: { page_size: 100, page_token: page } });
        for (const c of d.items ?? []) out.push({ id: c.chat_id, name: c.name || 'Chat', detail: 'Lark chat' });
        page = d.has_more ? d.page_token : undefined;
      } while (page && out.length < 500);
      return out;
    },
    async publish(target, note: Note, opts: PublishOptions) {
      const m = noteModel(note, opts);
      await call(ctx, 'POST', '/im/v1/messages', { query: { receive_id_type: 'chat_id' }, json: { receive_id: target.id, msg_type: 'post', content: JSON.stringify(larkPost(m)) } });
      return { url: `https://applink.larksuite.com/client/chat/open?openChatId=${encodeURIComponent(target.id)}` };
    },
  };
}

export async function larkProfile(ctx: ApiCtx): Promise<Profile> {
  const d = await call<{ name?: string; en_name?: string; email?: string; open_id?: string; user_id?: string }>(ctx, 'GET', '/authen/v1/user_info');
  return { id: d.open_id ?? d.user_id ?? d.email ?? 'lark', label: d.email ?? d.en_name ?? d.name ?? 'Lark account' };
}
