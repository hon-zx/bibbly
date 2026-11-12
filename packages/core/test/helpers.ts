import { DEMO_MEETING } from '../src/demo.js';
import type { Clarity, Line, Note } from '../src/types.js';

export function sine(freq: number, rate: number, seconds: number, amp = 0.5): Float32Array {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

export function toInt16(f: Float32Array): Int16Array {
  return Int16Array.from(f, v => Math.round(Math.max(-1, Math.min(1, v)) * 32767));
}

/** Speech-like test signal: quiet noise with loud voiced bursts. */
export function bursts(rate: number, pattern: [silenceSec: number, speechSec: number][]): Int16Array {
  const parts: number[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (const [sil, sp] of pattern) {
    for (let i = 0; i < sil * rate; i++) parts.push(rnd() * 0.002);
    for (let i = 0; i < sp * rate; i++) parts.push(0.4 * Math.sin((2 * Math.PI * 180 * i) / rate) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * i) / rate)) + rnd() * 0.01);
  }
  for (let i = 0; i < 0.8 * rate; i++) parts.push(rnd() * 0.002);
  return toInt16(Float32Array.from(parts));
}

export function demoNote(): Note {
  const lines: Line[] = DEMO_MEETING.lines.map((l, i) => {
    const sp = DEMO_MEETING.speakers.find(s => s.id === l.speaker)!;
    return { id: `d${i + 1}`, t: l.t, speaker: { id: sp.id, name: sp.id === 'me' ? 'Alex' : sp.name, ...(sp.id === 'me' ? { self: true } : {}) },
             channel: 'demo', text: l.text, lang: l.lang, ...('langs' in l && l.langs ? { langs: l.langs } : {}), confidence: l.confidence, tr: { ...l.tr } };
  });
  const clarity: Clarity = {
    summary: [{ src: 'en', text: { en: 'Launch dates locked: Singapore on Nov 28, Japan on Dec 5.', zh: '上市日期已确定：新加坡 11 月 28 日，日本 12 月 5 日。' } }],
    decisions: [{ src: 'en', text: { en: 'Prices: S$129 (SG) · ¥13,800 incl. tax (JP)' } }],
    actions: [
      { id: 'a1', src: 'en', text: { en: 'Send packaging files to Sato', zh: '把包装文件发给佐藤' }, owner: 'Li Wei', ownerIsMe: false, due: new Date(2026, 10, 12, 18, 0).getTime(), lineId: 'd4' },
      { id: 'a3', src: 'en', text: { en: 'Get finance sign-off on pricing' }, owner: 'Alex', ownerIsMe: true, due: new Date(2026, 10, 13).getTime(), lineId: 'd8' },
    ],
    followup: { src: 'en', text: { en: 'Packaging review' }, when: new Date(2026, 10, 17, 10, 0).getTime(), durationMin: 45 },
    updatedAt: 0,
  };
  return { id: 'n1', title: DEMO_MEETING.title, startedAt: new Date(2026, 10, 11, 16, 30).getTime(), durationSec: 232, source: 'Laptop mic + meeting audio',
           platform: 'zoom', languages: ['zh', 'en', 'ja'], speakers: [], lines, clarity, sentTo: [] };
}
