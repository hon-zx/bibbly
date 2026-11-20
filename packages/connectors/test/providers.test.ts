import type { Note } from '@bibbly/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakes, type Fake } from '../src/testing/fakes.js';
import { harness, type Harness } from './helpers.js';

let fake: Fake;
let h: Harness;
beforeAll(async () => { fake = await startFakes(); h = harness(fake); });
afterAll(() => fake.close());

const at = (iso: string) => Date.parse(iso);

function sampleNote(lines = 3): Note {
  return {
    id: 'note-1', title: 'Q4 launch sync', startedAt: at('2026-11-18T08:00:00Z'), durationSec: 900, source: 'Laptop mic', languages: ['zh', 'en'],
    speakers: [], sentTo: [],
    lines: Array.from({ length: lines }, (_, i) => ({
      id: `l${i}`, t: i * 5, speaker: { id: 'li', name: 'Li Wei' }, channel: 'system' as const, text: `第${i}句`, lang: 'zh', tr: { en: `Line ${i} in English` },
    })),
    clarity: {
      summary: [{ src: 'en', text: { en: 'Launch dates locked: Singapore Nov 28, Japan Dec 5.' } }],
      decisions: [{ src: 'en', text: { en: 'Ship Singapore first.' } }],
      actions: [{ id: 'a1', src: 'en', text: { en: 'Send packaging files to Sato' }, owner: 'Li Wei', ownerIsMe: false, due: at('2026-11-20T00:00:00Z') }],
      followup: null, updatedAt: 0,
    },
  };
}

describe('Google', () => {
  it('lists events with paging and works out the meeting app', async () => {
    const acct = await h.connect('google');
    expect(acct).toMatchObject({ id: 'google:ada@example.com', label: 'ada@example.com', method: 'loopback' });
    for (const [i, e] of [
      { summary: 'Standup', hangoutLink: 'https://meet.google.com/xyz' },
      { summary: 'Vendor call', location: 'https://acme.zoom.us/j/123' },
      { summary: 'Lunch', location: 'Lau Pa Sat' },
    ].entries()) fake.google.events.set(`seed${i}`, { id: `seed${i}`, etag: `"s${i}"`, ...e, start: { dateTime: `2026-11-2${i}T02:00:00Z` }, end: { dateTime: `2026-11-2${i}T02:30:00Z` } });
    fake.google.events.set('allday', { id: 'allday', etag: '"a"', summary: 'Holiday', start: { date: '2026-11-25' }, end: { date: '2026-11-26' } });
    const cal = h.connectors.calendar(acct)!;
    const events = await cal.listEvents('primary', at('2026-11-19T00:00:00Z'), at('2026-12-19T00:00:00Z'));
    expect(events.map(e => [e.title, e.platform])).toEqual([['Standup', 'meet'], ['Vendor call', 'zoom'], ['Lunch', 'in-person'], ['Holiday', 'other']]);
    expect(events[0]!.meetUrl).toBe('https://meet.google.com/xyz');
    expect(events[3]!.allDay).toBe(true);
    const made = await cal.createEvent('primary', { title: 'Packaging review', start: at('2026-11-24T02:00:00Z'), end: at('2026-11-24T02:45:00Z'), platform: 'meet', addMeeting: true });
    expect(made.meetUrl).toBe('https://meet.google.com/abc-defg-hij');
    await cal.deleteEvent('primary', made.id);
    await cal.deleteEvent('primary', made.id); // already gone: no error
  });

  it('keeps only the date of a due time, as Google Tasks does', async () => {
    const acct = h.state.accounts.find(a => a.provider === 'google')!;
    const tasks = h.connectors.tasks(acct)!;
    const list = await tasks.findOrCreateList('Bibbly');
    expect((await tasks.findOrCreateList('bibbly')).id).toBe(list.id);
    const due = new Date(2026, 10, 20, 15, 0).getTime();
    const t = await tasks.createTask(list.id, { title: 'Send deck', due, dueHasTime: true, completed: false, remind: true });
    expect(new Date(t.due!).getHours()).toBe(0);
    expect(new Date(t.due!).getDate()).toBe(20);
    const done = await tasks.updateTask(list.id, t.id, { title: 'Send deck', due: null, dueHasTime: false, completed: true, remind: false });
    expect(done).toMatchObject({ completed: true, due: null });
    expect(done.completedAt).toBeTruthy();
  });

  it('saves a note as a Google Doc in a Bibbly folder', async () => {
    const acct = h.state.accounts.find(a => a.provider === 'google')!;
    const copy = await h.connectors.publish(acct, sampleNote(), { lang: 'en' });
    await h.connectors.publish(acct, sampleNote(), { lang: 'en' });
    expect(copy).toMatchObject({ provider: 'google', target: 'Bibbly notes folder' });
    expect(copy.url).toMatch(/docs\.google\.com\/document\/d\//);
    expect(fake.google.folders).toHaveLength(1);
    expect(fake.google.docs[0]).toMatchObject({ name: 'Q4 launch sync', mimeType: 'application/vnd.google-apps.document', parents: [fake.google.folders[0]!.id] });
    expect(fake.google.docs[0]!.html).toContain('Launch dates locked');
    expect(fake.google.docs[0]!.html).toContain('Line 0 in English');
  });
});

describe('Microsoft 365', () => {
  it('reads UTC calendar times and creates Teams meetings', async () => {
    const acct = await h.connect('microsoft');
    expect(acct.label).toBe('grace@contoso.com');
    for (let i = 0; i < 3; i++) {
      fake.microsoft.events.set(`ms${i}`, { id: `ms${i}`, subject: `Sync ${i}`, start: { dateTime: `2026-11-2${i}T01:00:00.0000000`, timeZone: 'UTC' }, end: { dateTime: `2026-11-2${i}T01:30:00.0000000`, timeZone: 'UTC' },
        changeKey: `k${i}`, isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' } });
    }
    const cal = h.connectors.calendar(acct)!;
    const events = await cal.listEvents('primary', at('2026-11-19T00:00:00Z'), at('2026-12-19T00:00:00Z'));
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ title: 'Sync 0', start: at('2026-11-20T01:00:00Z'), platform: 'teams' });
    const made = await cal.createEvent('primary', { title: 'Follow-up', start: at('2026-11-25T01:00:00Z'), end: at('2026-11-25T01:30:00Z'), platform: 'teams', addMeeting: true });
    expect(made.meetUrl).toContain('teams.microsoft.com');
    expect(fake.microsoft.events.get(made.id)!.start).toEqual({ dateTime: '2026-11-25T01:00:00', timeZone: 'UTC' });
  });

  it('maps To Do due dates and reminders', async () => {
    const acct = h.state.accounts.find(a => a.provider === 'microsoft')!;
    const todo = h.connectors.tasks(acct)!;
    const list = await todo.findOrCreateList('Bibbly');
    const due = new Date(2026, 10, 21, 9, 30).getTime();
    const t = await todo.createTask(list.id, { title: 'Call Mom', due, dueHasTime: true, completed: false, remind: true });
    expect(t).toMatchObject({ due, dueHasTime: true });
    const raw = fake.microsoft.tasks.get(list.id)![0]!;
    expect(raw).toMatchObject({ isReminderOn: true, status: 'notStarted' });
    const plain = await todo.createTask(list.id, { title: 'Water plants', due, dueHasTime: true, completed: false, remind: false });
    expect(plain.dueHasTime).toBe(false);
    expect(new Date(plain.due!).getHours()).toBe(0);
  });

  it('posts notes to a Teams channel', async () => {
    const acct = h.state.accounts.find(a => a.provider === 'microsoft')!;
    const targets = await h.connectors.notes(acct)!.listTargets();
    expect(targets.map(t => t.name)).toEqual(['Product › General', 'Product › Launch']);
    const copy = await h.connectors.publish(acct, sampleNote(), { lang: 'en' }, targets[1]);
    expect(copy.url).toContain('teams.microsoft.com/l/message/chan-2/');
    expect(fake.microsoft.messages[0]!.body.content).toContain('Send packaging files to Sato');
  });
});

describe('Slack', () => {
  it('joins the channel if needed, posts the notes and attaches the transcript', async () => {
    const acct = await h.connect('slack');
    expect(acct.label).toBe('Acme (Slack)');
    const targets = await h.connectors.notes(acct)!.listTargets();
    expect(targets.map(t => t.name)).toEqual(['#general', '#leadership', '#product']);
    const copy = await h.connectors.publish(acct, sampleNote(), { lang: 'en' }, targets.find(t => t.name === '#product'));
    expect(copy.url).toMatch(/^https:\/\/acme\.slack\.com\/archives\/C2\/p/);
    expect(fake.slack.joined.has('C2')).toBe(true);
    const msg = fake.slack.messages[0]!;
    expect(msg.blocks[0]).toMatchObject({ type: 'header', text: { text: 'Q4 launch sync' } });
    expect(JSON.stringify(msg.blocks)).toContain('Send packaging files to Sato');
    expect(fake.slack.completed[0]).toMatchObject({ channel_id: 'C2', thread_ts: msg.ts });
    expect([...fake.slack.uploads.values()][0]!.content).toContain('## Transcript');
  });
});

describe('Notion', () => {
  it('creates a page and appends long transcripts in batches of 100 blocks', async () => {
    const acct = await h.connect('notion');
    expect(acct.label).toBe('Acme HQ (Notion)');
    const [target] = await h.connectors.notes(acct)!.listTargets();
    expect(target).toMatchObject({ id: 'page-1', name: 'Meeting notes' });
    const long = sampleNote(150);
    long.lines[0]!.tr.en = 'x'.repeat(4500); // longer than one rich_text item allows
    const copy = await h.connectors.publish(acct, long, { lang: 'en' }, target);
    expect(copy.url).toMatch(/^https:\/\/www\.notion\.so\/np-/);
    const page = fake.notion.pages.at(-1)!;
    expect(page.title).toBe('Q4 launch sync');
    expect(page.children.length).toBeGreaterThan(150); // all blocks arrived over several requests
    expect(page.children.some((b: any) => b.type === 'to_do')).toBe(true);
  });
});

describe('Lark', () => {
  it('syncs calendar and tasks and posts notes to a chat', async () => {
    const acct = await h.connect('lark');
    expect(acct.label).toBe('lin@acme.example');
    const cal = h.connectors.calendar(acct)!;
    const primary = await cal.primaryCalendar();
    expect(primary.id).toBe('lcal-1');
    const ev = await cal.createEvent(primary.id, { title: 'Review', start: at('2026-11-24T06:00:00Z'), end: at('2026-11-24T06:30:00Z'), platform: 'lark', addMeeting: true });
    expect(ev).toMatchObject({ platform: 'lark', meetUrl: 'https://vc.larksuite.com/j/123456789' });
    expect((await cal.listEvents(primary.id, at('2026-11-19T00:00:00Z'), at('2026-12-19T00:00:00Z'))).map(e => e.title)).toEqual(['Review']);
    const tasks = h.connectors.tasks(acct)!;
    const list = await tasks.findOrCreateList('Bibbly');
    const t = await tasks.createTask(list.id, { title: 'Book flights', due: at('2026-11-22T01:00:00Z'), dueHasTime: true, completed: false, remind: false });
    const done = await tasks.updateTask(list.id, t.id, { title: 'Book flights', due: null, dueHasTime: false, completed: true, remind: false });
    expect(done).toMatchObject({ completed: true, due: null });
    const copy = await h.connectors.publish(acct, sampleNote(), { lang: 'en' }, { id: 'oc_1', name: 'Launch team' });
    expect(copy.url).toContain('oc_1');
    expect(fake.lark.messages[0]!.content.en_us.title).toBe('Q4 launch sync');
    await expect(h.connectors.publish(acct, sampleNote(), { lang: 'en' }, { id: 'oc_x', name: 'Gone' })).rejects.toThrow(/chat not found/);
  });
});
