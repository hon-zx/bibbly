import { describe, expect, it } from 'vitest';
import { addDays, atTime, dueFrom, isoDay, parseDateTime, weekStart } from '../src/dates.js';
import { detectedLabel, guessLang, guessMixed, normLang } from '../src/lang.js';
import { parseQuickTask } from '../src/tasks.js';

describe('languages', () => {
  it('guesses the script-based language', () => {
    expect(guessLang('日本は少し遅れそうです')).toBe('ja');
    expect(guessLang('没问题，我们开始吧')).toBe('zh');
    expect(guessLang('안녕하세요')).toBe('ko');
    expect(guessLang('Hello there', 'es')).toBe('es');
    expect(guessLang('Hello there', 'ja')).toBe('en');
  });
  it('spots Mandarin–English mixing but not Japanese kanji', () => {
    expect(guessMixed('Great. So 我们 lock 两个日期 now')).toEqual(['en', 'zh']);
    expect(guessMixed('今天主要确认 Nimbus Lite 在新加坡的上市时间')).toBeNull();
    expect(guessMixed('Nimbus Lite の発売日は 12 月です')).toBeNull();
    expect(guessMixed('没问题')).toBeNull();
  });
  it('normalises engine language tags', () => {
    expect(['zh-CN', 'zh-TW', 'zh-HK', 'cmn-Hans-CN', 'ja-JP', 'en_US', 'xx'].map(normLang)).toEqual(['zh', 'zh-Hant', 'yue', 'zh', 'ja', 'en', 'xx']);
    expect(normLang('')).toBeNull();
  });
  it('labels mixed lines', () => {
    expect(detectedLabel('en', ['en', 'zh'])).toBe('English + Mandarin');
    expect(detectedLabel('ja')).toBe('Japanese');
  });
});

describe('dates and due rules', () => {
  const thu = new Date(2026, 10, 12); // Thursday
  const sat = new Date(2026, 10, 14);
  const sun = new Date(2026, 10, 15);
  it('resolves relative due dates', () => {
    expect(isoDay(dueFrom(thu, { weekday: 'fri' }))).toBe('2026-11-13');
    expect(isoDay(dueFrom(sat, { weekday: 'fri' }))).toBe('2026-11-20');
    expect(isoDay(dueFrom(thu, { nextWeek: 2 }))).toBe('2026-11-17');
    expect(isoDay(dueFrom(sun, { nextWeek: 2 }))).toBe('2026-11-17');
    expect(isoDay(dueFrom(thu, { nextMonday: true }))).toBe('2026-11-16');
    expect(isoDay(dueFrom(thu, { weekday: 'sun' }))).toBe('2026-11-15');
    expect(dueFrom(thu, { days: 1, time: '12:00' }).getHours()).toBe(12);
  });
  it('parses model dates defensively', () => {
    expect(parseDateTime('2026-11-17', '10:00')).toBe(atTime(new Date(2026, 10, 17), '10:00').getTime());
    expect(parseDateTime('tomorrow')).toBeNull();
    expect(parseDateTime(null)).toBeNull();
  });
});

describe('quick-add task parser', () => {
  const now = new Date(2026, 10, 12, 9, 30); // Thu 09:30
  it('reads dates, times and lists', () => {
    const p = parseQuickTask('Send deck to Li Wei tomorrow 3pm', now);
    expect(p.title).toBe('Send deck to Li Wei');
    expect(p.due).toBe(atTime(addDays(new Date(2026, 10, 12), 1), '15:00').getTime());
    expect(p.remind).toBe(true);
    expect(p.list).toBe('Work');
  });
  it('handles reminders, tags and weekdays', () => {
    expect(parseQuickTask('remind me to call mom tonight', now)).toMatchObject({ title: 'Call mom', remind: true, list: 'Personal' });
    expect(parseQuickTask('water the plants #home', now)).toMatchObject({ title: 'Water the plants', list: 'Home', due: null });
    const nf = parseQuickTask('Lunch with Mei next friday at 12:30', now);
    expect(nf.due).toBe(atTime(addDays(weekStart(now), 11), '12:30').getTime());
    expect(parseQuickTask('gym in 3 days', now).due).toBe(addDays(new Date(2026, 10, 12), 3).getTime());
  });
  it('puts a past time on the next day', () => {
    expect(parseQuickTask('stand-up at 9am', now).due).toBe(atTime(new Date(2026, 10, 13), '09:00').getTime());
  });
});
