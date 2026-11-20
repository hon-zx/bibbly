import type { CalendarEvent, Task } from '@bibbly/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakes, type Fake } from '../src/testing/fakes.js';
import { harness, type Harness } from './helpers.js';

let fake: Fake;
let h: Harness;
const fakes: Fake[] = [];
beforeEach(async () => { fake = await startFakes(); fakes.push(fake); h = harness(fake); });
afterAll(async () => { for (const f of fakes) await f.close(); });

const NOW = Date.UTC(2026, 10, 19, 9, 0, 0);
const task = (id: string, title: string, extra: Partial<Task> = {}): Task => ({ id, title, list: 'Work', due: null, remind: false, done: false, updatedAt: NOW - 1000, ...extra });

async function sync(data: { tasks: Task[]; events: CalendarEvent[] }) {
  const r = await h.connectors.syncAll(h.state, data);
  h.state = r.state;
  return r;
}

describe('task sync', () => {
  it('copies tasks both ways, then edits, completions and deletions', async () => {
    const acct = await h.connect('google');
    const gList = () => fake.google.tasks.get(h.state.accounts[0]!.settings.tasks!.listId!)!;
    // 1. Bibbly task goes to Google Tasks (a new "Bibbly" list); old finished tasks stay home.
    let r = await sync({ tasks: [task('t1', 'Send deck to Li Wei', { due: new Date(2026, 10, 20, 15, 0).getTime(), remind: true }), task('old', 'Old', { done: true, doneAt: NOW - 10 * 86_400_000 })], events: [] });
    expect(fake.google.lists.map(l => l.title)).toContain('Bibbly');
    expect(gList().map(t => t.title)).toEqual(['Send deck to Li Wei']);
    expect(r.data.tasks.find(t => t.id === 't1')!.synced).toEqual([expect.objectContaining({ provider: 'google', accountId: acct.id })]);
    expect(r.status[acct.id]).toMatchObject({ ok: true, pushed: 1 });
    // The 3pm time survives even though Google keeps only the date.
    r = await sync(r.data);
    expect(new Date(r.data.tasks.find(t => t.id === 't1')!.due!).getHours()).toBe(15);

    // 2. A task added in Google appears in Bibbly.
    gList().push({ id: 'gt-x', title: 'Renew passport', status: 'needsAction', updated: new Date(NOW).toISOString() });
    r = await sync(r.data);
    const imported = r.data.tasks.find(t => t.title === 'Renew passport')!;
    expect(imported).toMatchObject({ list: 'Work', done: false });

    // 3. Completed in Google -> completed in Bibbly.
    const g1 = gList().find(t => t.title === 'Send deck to Li Wei')!;
    Object.assign(g1, { status: 'completed', completed: new Date(NOW + 5000).toISOString(), updated: new Date(NOW + 5000).toISOString() });
    r = await sync(r.data);
    expect(r.data.tasks.find(t => t.id === 't1')!.done).toBe(true);

    // 4. Renamed in Bibbly -> renamed in Google.
    r.data.tasks = r.data.tasks.map(t => (t.id === imported.id ? { ...t, title: 'Renew passport (online)', updatedAt: NOW + 60_000 } : t));
    r = await sync(r.data);
    expect(gList().find(t => t.id === 'gt-x')!.title).toBe('Renew passport (online)');

    // 5. Changed on both sides: the later edit wins.
    const gx = gList().find(t => t.id === 'gt-x')!;
    Object.assign(gx, { title: 'Passport: older edit', updated: new Date(NOW + 61_000).toISOString() });
    r.data.tasks = r.data.tasks.map(t => (t.id === imported.id ? { ...t, title: 'Passport: newer edit', updatedAt: NOW + 120_000 } : t));
    r = await sync(r.data);
    expect(gx.title === 'Passport: newer edit' || gList().find(t => t.id === 'gt-x')!.title === 'Passport: newer edit').toBe(true);
    expect(r.data.tasks.find(t => t.id === imported.id)!.title).toBe('Passport: newer edit');

    // 6. Deleted in Bibbly -> deleted in Google; deleted in Google -> deleted in Bibbly.
    r = await sync({ ...r.data, tasks: r.data.tasks.filter(t => t.id !== imported.id) });
    expect(gList().some(t => t.id === 'gt-x')).toBe(false);
    gList().splice(0, gList().length);
    r = await sync(r.data);
    expect(r.data.tasks.map(t => t.id)).toEqual(['old']);
  });

  it('pairs a task that already exists in the app instead of duplicating it', async () => {
    await h.connect('microsoft');
    await sync({ tasks: [], events: [] }); // creates the Bibbly list
    const listId = h.state.accounts[0]!.settings.tasks!.listId!;
    fake.microsoft.tasks.get(listId)!.push({ id: 'mt-dup', title: 'Book flights to Tokyo', status: 'notStarted', lastModifiedDateTime: new Date(NOW).toISOString() });
    const r = await sync({ tasks: [task('t9', 'book flights to tokyo')], events: [] });
    expect(fake.microsoft.tasks.get(listId)).toHaveLength(1);
    expect(r.data.tasks).toHaveLength(1);
  });

  it('mirrors tasks across two connected apps', async () => {
    await h.connect('google');
    await h.connect('microsoft');
    const r = await sync({ tasks: [task('t1', 'Draft agenda')], events: [] });
    const gl = fake.google.tasks.get(h.state.accounts[0]!.settings.tasks!.listId!)!;
    const ml = fake.microsoft.tasks.get(h.state.accounts[1]!.settings.tasks!.listId!)!;
    expect(gl.map(t => t.title)).toEqual(['Draft agenda']);
    expect(ml.map(t => t.title)).toEqual(['Draft agenda']);
    expect(r.data.tasks[0]!.synced).toHaveLength(2);
  });
});

describe('calendar sync', () => {
  it('brings in meetings, saves Bibbly follow-ups, and follows edits and deletions', async () => {
    const acct = await h.connect('google');
    fake.google.events.set('ext1', { id: 'ext1', etag: '"1"', summary: 'Q4 launch sync', start: { dateTime: '2026-11-20T08:00:00Z' }, end: { dateTime: '2026-11-20T08:30:00Z' }, hangoutLink: 'https://meet.google.com/q4' });
    const followUp: CalendarEvent = { id: 'fu1', title: 'Packaging review', start: Date.parse('2026-11-24T02:00:00Z'), durationMin: 45, platform: 'meet', bibblyJoins: true, prevNoteId: 'note-1', languages: ['zh', 'en'], updatedAt: NOW - 1 };
    let r = await sync({ tasks: [], events: [followUp] });
    const q4 = r.data.events.find(e => e.title === 'Q4 launch sync')!;
    expect(q4).toMatchObject({ platform: 'meet', meetUrl: 'https://meet.google.com/q4', durationMin: 30, bibblyJoins: false, source: { provider: 'google', readOnly: true } });
    const saved = [...fake.google.events.values()].find(e => e.summary === 'Packaging review')!;
    expect(saved.hangoutLink).toBe('https://meet.google.com/abc-defg-hij');
    expect(saved.description).toContain('Bibbly');
    const fu = r.data.events.find(e => e.id === 'fu1')!;
    expect(fu).toMatchObject({ meetUrl: 'https://meet.google.com/abc-defg-hij', source: { eventId: saved.id }, bibblyJoins: true, languages: ['zh', 'en'] });
    expect(r.status[acct.id]).toMatchObject({ ok: true, pulled: 1, pushed: 1 });

    // Bibbly-only details survive a change in Google; the title and time follow Google.
    r.data.events = r.data.events.map(e => (e.id === q4.id ? { ...e, bibblyJoins: true, languages: ['zh'] } : e));
    Object.assign(fake.google.events.get('ext1')!, { summary: 'Q4 launch sync (moved)', etag: '"2"', start: { dateTime: '2026-11-20T09:00:00Z' }, end: { dateTime: '2026-11-20T10:00:00Z' } });
    r = await sync(r.data);
    expect(r.data.events.find(e => e.id === q4.id)).toMatchObject({ title: 'Q4 launch sync (moved)', durationMin: 60, bibblyJoins: true, languages: ['zh'] });

    // Moving the follow-up in Bibbly moves it in Google.
    r.data.events = r.data.events.map(e => (e.id === 'fu1' ? { ...e, start: Date.parse('2026-11-25T02:00:00Z'), updatedAt: NOW + 10 } : e));
    r = await sync(r.data);
    expect(fake.google.events.get(saved.id)!.start.dateTime).toBe('2026-11-25T02:00:00.000Z');

    // Deleted in Google: gone from Bibbly. Deleted in Bibbly: gone from Google.
    fake.google.events.delete('ext1');
    r = await sync({ ...r.data, events: r.data.events.filter(e => e.id !== 'fu1') });
    expect(r.data.events).toHaveLength(0);
    expect(fake.google.events.has(saved.id)).toBe(false);
  });

  it('saves follow-ups to only one calendar and keeps notes when a meeting is cancelled', async () => {
    await h.connect('google');
    await h.connect('microsoft');
    expect(h.state.accounts.map(a => a.settings.calendar!.push)).toEqual([true, false]);
    fake.microsoft.events.set('m1', { id: 'm1', subject: 'Board', start: { dateTime: '2026-11-21T01:00:00' }, end: { dateTime: '2026-11-21T02:00:00' }, changeKey: 'a' });
    let r = await sync({ tasks: [], events: [{ id: 'fu', title: 'Follow-up', start: Date.parse('2026-11-26T01:00:00Z'), durationMin: 30, platform: 'teams', bibblyJoins: false }] });
    expect([...fake.google.events.values()].map(e => e.summary)).toEqual(['Follow-up']);
    expect([...fake.microsoft.events.values()].map(e => e.subject)).toEqual(['Board']);
    // A meeting that already has notes stays in Bibbly when it's cancelled, without its calendar link.
    r.data.events = r.data.events.map(e => (e.title === 'Board' ? { ...e, noteId: 'note-9' } : e));
    fake.microsoft.events.delete('m1');
    r = await sync(r.data);
    const board = r.data.events.find(e => e.title === 'Board')!;
    expect(board.noteId).toBe('note-9');
    expect(board.source).toBeUndefined();
  });
});

describe('engine', () => {
  it('refreshes an expired token and retries', async () => {
    const acct = await h.connect('google');
    fake.expire('google');
    const r = await sync({ tasks: [task('t1', 'Anything')], events: [] });
    expect(r.status[acct.id]!.ok).toBe(true);
    expect(fake.google.refreshes).toBe(1);
    // Refreshes ahead of expiry too.
    const t = (await h.tokens.get(acct.id))!;
    await h.tokens.set(acct.id, { ...t, expiresAt: NOW + 10_000 });
    await sync(r.data);
    expect(fake.google.refreshes).toBe(2);
  });

  it('reports a revoked connection in the status instead of throwing', async () => {
    const acct = await h.connect('google');
    const t = (await h.tokens.get(acct.id))!;
    await h.tokens.set(acct.id, { ...t, accessToken: 'revoked', refreshToken: 'revoked' });
    const r = await sync({ tasks: [], events: [] });
    expect(r.status[acct.id]).toMatchObject({ ok: false });
    expect(r.status[acct.id]!.message).toMatch(/revoked|connect/i);
  });

  it('disconnecting removes the account, its tokens and the events it brought in', async () => {
    const acct = await h.connect('google');
    fake.google.events.set('e', { id: 'e', etag: '"1"', summary: 'Standup', start: { dateTime: '2026-11-20T01:00:00Z' }, end: { dateTime: '2026-11-20T01:15:00Z' } });
    const r = await sync({ tasks: [task('t1', 'Keep me')], events: [] });
    const out = await h.connectors.removeAccount(h.state, acct.id, r.data);
    expect(out.state.accounts).toHaveLength(0);
    expect(out.state.links).toHaveLength(0);
    expect(out.data.events).toHaveLength(0);
    expect(out.data.tasks[0]).toMatchObject({ id: 't1', synced: [] });
    expect(await h.tokens.get(acct.id)).toBeNull();
    expect(fake.google.revoked).toEqual(['g-rt']); // Google was asked to revoke Bibbly's access
  });

  it('keeps tokens small: the id_token is not stored', async () => {
    const acct = await h.connect('google');
    expect((await h.tokens.get(acct.id))!.extra?.id_token).toBeUndefined();
  });
});

describe('disconnecting Slack', () => {
  it('revokes the bot token', async () => {
    const acct = await h.connect('slack');
    const out = await h.connectors.removeAccount(h.state, acct.id, { tasks: [], events: [] });
    expect(out.state.accounts).toHaveLength(0);
    expect(fake.slack.revoked).toBe(1);
  });
});
