/**
 * Two-way task sync between Bibbly and one task list in a connected app.
 *
 * - A task changed on one side since the last sync is copied to the other.
 * - Changed on both sides: the most recent edit wins.
 * - Deleted on one side: deleted on the other, unless the other side edited it
 *   after the last sync (then it comes back).
 * - New tasks flow both ways; an existing task with the same title and due day
 *   is paired instead of duplicated.
 */
import { hasTime, sameDay, uid, type Task } from '@bibbly/core';
import type { ConnectedAccount, RemoteTask, SyncLink, TaskApi, TaskInput } from '../types.js';

export interface TaskSyncResult { tasks: Task[]; links: SyncLink[]; pulled: number; pushed: number; removed: number }

const DAY = 86_400_000;
const ver = (t: Task) => String(t.updatedAt ?? 0);
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export function taskInput(t: Task): TaskInput {
  return { title: t.title, notes: t.notes ?? '', due: t.due, dueHasTime: t.due != null && hasTime(t.due), completed: t.done, remind: t.remind };
}

/** Apps that store only a date keep Bibbly's time when the day is unchanged. */
function mergeDue(local: number | null, r: RemoteTask): number | null {
  if (r.due == null) return null;
  if (!r.dueHasTime && local != null && sameDay(local, r.due)) return local;
  return r.due;
}

function withRef(t: Task, account: ConnectedAccount, url?: string): Task {
  const others = (t.synced ?? []).filter(s => s.accountId !== account.id);
  return { ...t, synced: [...others, { provider: account.provider, accountId: account.id, ...(url ? { url } : {}) }] };
}

function fromRemote(r: RemoteTask, account: ConnectedAccount, now: number, id?: string): Task {
  return withRef({
    id: id ?? uid('task-'), title: r.title || 'Untitled', list: account.settings.tasks?.localList ?? 'Work',
    due: r.due, remind: r.dueHasTime, done: r.completed, doneAt: r.completed ? r.completedAt ?? now : null,
    ...(r.notes ? { notes: r.notes } : {}), updatedAt: r.updated || now,
  }, account, r.url);
}

function applyRemote(l: Task, r: RemoteTask, account: ConnectedAccount, now: number): Task {
  return withRef({
    ...l, title: r.title || l.title, due: mergeDue(l.due, r), done: r.completed,
    doneAt: r.completed ? r.completedAt ?? l.doneAt ?? now : null,
    ...(r.notes !== undefined ? { notes: r.notes } : {}), updatedAt: Math.max(l.updatedAt ?? 0, r.updated || now),
  }, account, r.url);
}

export async function syncTasks(api: TaskApi, account: ConnectedAccount, listId: string, tasks: Task[], links: SyncLink[], now: number): Promise<TaskSyncResult> {
  const remote = await api.listTasks(listId);
  const remoteById = new Map(remote.map(r => [r.id, r]));
  let out = [...tasks];
  const keep = links.filter(l => !(l.kind === 'task' && l.accountId === account.id));
  const mine = links.filter(l => l.kind === 'task' && l.accountId === account.id && l.container === listId);
  const seenRemote = new Set<string>();
  const seenLocal = new Set<string>();
  let pulled = 0, pushed = 0, removed = 0;
  const put = (t: Task) => { const i = out.findIndex(x => x.id === t.id); if (i >= 0) out[i] = t; else out.push(t); };
  const link = (t: Task, r: RemoteTask, origin: SyncLink['origin']): SyncLink => ({
    kind: 'task', accountId: account.id, localId: t.id, remoteId: r.id, container: listId, origin, localVersion: ver(t), remoteVersion: r.version, syncedAt: now,
  });

  for (const l of mine) {
    const L = out.find(t => t.id === l.localId);
    const R = remoteById.get(l.remoteId);
    if (R) seenRemote.add(R.id);
    if (L) seenLocal.add(L.id);
    if (!L && !R) continue;
    if (!L && R) {
      if (R.version !== l.remoteVersion) { const t = fromRemote(R, account, now, l.localId); out.push(t); keep.push(link(t, R, l.origin)); pulled++; }
      else { await api.deleteTask(listId, R.id); removed++; }
      continue;
    }
    if (L && !R) {
      if (ver(L) !== l.localVersion) { const c = await api.createTask(listId, taskInput(L)); seenRemote.add(c.id); const t = withRef(L, account, c.url); put(t); keep.push(link(t, c, l.origin)); pushed++; }
      else { out = out.filter(t => t.id !== L.id); removed++; }
      continue;
    }
    const localChanged = ver(L!) !== l.localVersion;
    const remoteChanged = R!.version !== l.remoteVersion;
    if (localChanged && (!remoteChanged || (L!.updatedAt ?? 0) >= R!.updated)) {
      const u = await api.updateTask(listId, R!.id, taskInput(L!));
      const t = withRef(L!, account, u.url ?? R!.url);
      put(t); keep.push(link(t, u, l.origin)); pushed++;
    } else if (remoteChanged) {
      const t = applyRemote(L!, R!, account, now);
      put(t); keep.push(link(t, R!, l.origin)); pulled++;
    } else {
      const t = withRef(L!, account, R!.url);
      put(t); keep.push({ ...l, localVersion: ver(t), syncedAt: now });
    }
  }

  const freeRemote = remote.filter(r => !seenRemote.has(r.id));
  for (const L of [...out]) {
    if (seenLocal.has(L.id)) continue;
    if (L.done && (L.doneAt ?? 0) < account.connectedAt) continue; // finished before connecting: leave it out
    const twin = freeRemote.find(r => norm(r.title) === norm(L.title) && (r.due == null ? L.due == null : L.due != null && sameDay(r.due, L.due)));
    if (twin) {
      freeRemote.splice(freeRemote.indexOf(twin), 1);
      const t = withRef(L, account, twin.url);
      put(t); keep.push(link(t, twin, 'local'));
      continue;
    }
    const c = await api.createTask(listId, taskInput(L));
    const t = withRef(L, account, c.url);
    put(t); keep.push(link(t, c, 'local')); pushed++;
  }
  for (const R of freeRemote) {
    if (R.completed && (R.completedAt ?? 0) < account.connectedAt - 7 * DAY) continue; // old finished tasks stay in the app
    const t = fromRemote(R, account, now);
    out.push(t); keep.push(link(t, R, 'remote')); pulled++;
  }
  return { tasks: out, links: keep, pulled, pushed, removed };
}
