import { addDays, atTime, DEMO_MEETING, DemoClarity, startOfDay, type CalendarEvent, type Line, type Note, type Task } from '@bibbly/core';
import { DEFAULT_CLAUDE_MODEL } from '@bibbly/core/claude';
import type { AppData, Settings } from '../src/shared/ipc.js';

export const DEFAULT_SETTINGS: Settings = {
  myName: 'You',
  myLang: 'en',
  speaking: ['en', 'zh', 'ja'],
  engine: 'demo',
  azureRegion: 'southeastasia',
  whisperUrl: 'http://localhost:8000',
  claudeModel: DEFAULT_CLAUDE_MODEL,
  fastMode: false,
  roomServer: 'http://localhost:8787',
  glossary: ['Bibbly', 'Nimbus Lite'],
};

/** First-run data: one example meeting with notes, a few tasks and events, all marked as examples. */
export async function seedData(locale: string): Promise<AppData> {
  const today = startOfDay(Date.now());
  const meetingStart = atTime(addDays(today, -1), '16:30').getTime();
  const lines: Line[] = DEMO_MEETING.lines.map((l, i) => {
    const sp = DEMO_MEETING.speakers.find(s => s.id === l.speaker)!;
    return { id: `example-${i + 1}`, t: l.t, speaker: sp.id === 'me' ? { id: 'me', name: 'You', self: true } : { id: sp.id, name: sp.name },
             channel: 'system', text: l.text, lang: l.lang, ...(l.langs ? { langs: l.langs } : {}), confidence: l.confidence, tr: { ...l.tr } };
  });
  const { clarity } = await new DemoClarity().summarize({
    lang: 'en', me: 'You', startedAt: meetingStart, final: true, lines: lines.map(l => ({ id: l.id, t: l.t, speaker: l.speaker.name, text: l.text })),
  });
  const note: Note = {
    id: 'example-note', title: `${DEMO_MEETING.title} (example)`, startedAt: meetingStart, durationSec: 232, source: 'Laptop mic + meeting audio',
    platform: 'zoom', languages: ['zh', 'en', 'ja'], speakers: [], lines, clarity, sentTo: [],
  };
  const tasks: Task[] = [
    { id: 'example-t1', title: 'Get finance sign-off on Nimbus Lite pricing', list: 'Work', due: clarity.actions.find(a => a.ownerIsMe)?.due ?? null, remind: true, done: false,
      source: { noteId: note.id, lineId: 'example-8', actionId: 'demo-a3' } },
    { id: 'example-t2', title: 'Call Mom', list: 'Personal', due: atTime(today, '20:30').getTime(), remind: true, done: false },
    { id: 'example-t3', title: 'Water the plants', list: 'Home', due: today.getTime(), remind: false, done: false, repeat: 'Every 3 days' },
  ];
  const events: CalendarEvent[] = [
    { id: 'example-e1', title: 'Q4 launch sync', start: meetingStart, durationMin: 15, platform: 'zoom', languages: ['zh', 'en', 'ja'], bibblyJoins: true, noteId: note.id },
    { id: 'example-e2', title: 'Packaging review', start: clarity.followup?.when ?? atTime(addDays(today, 5), '10:00').getTime(), durationMin: 45, platform: 'zoom',
      languages: ['zh', 'en', 'ja'], bibblyJoins: true, prevNoteId: note.id, attendees: 'Li Wei, Jun Lim, Sato Yuki' },
  ];
  const myLang = locale.toLowerCase().startsWith('zh') ? 'zh' : locale.toLowerCase().startsWith('ja') ? 'ja' : 'en';
  return { version: 1, notes: [note], tasks, events, settings: { ...DEFAULT_SETTINGS, myLang } };
}
