import { describe, expect, it, vi } from 'vitest';
import { DEMO_MEETING } from '../src/demo.js';
import type { ClarityEngine, TranslateRequest, Translator } from '../src/llm/types.js';
import { LiveSession } from '../src/session/engine.js';
import { ScriptedSpeechProvider } from '../src/speech/scripted.js';

class FakeTranslator implements Translator {
  calls: TranslateRequest[] = [];
  failNext = false;
  async translate(req: TranslateRequest) {
    this.calls.push(req);
    if (this.failNext) { this.failNext = false; throw new Error('rate limited'); }
    return req.items.map(i => ({ id: i.id, translation: `[${req.target}] ${i.text}`, lang: /[一-鿿]/.test(i.text) ? 'zh' : 'en', langs: [], confidence: 0.9 }));
  }
}

const fakeClarity: ClarityEngine = {
  summarize: vi.fn(async req => ({
    title: 'Launch sync',
    clarity: { summary: [{ src: req.lang, text: { [req.lang]: `${req.lines.length} lines` } }], decisions: [], actions: [], followup: null, updatedAt: 1 },
  })),
};

describe('LiveSession', () => {
  it('turns a speech stream into translated lines and notes', async () => {
    const translator = new FakeTranslator();
    const s = new LiveSession({ me: { id: 'me', name: 'Alex', self: true }, myLang: 'en', candidateLanguages: ['en', 'zh', 'ja'], autoClarityEvery: 2 },
                              { translator, clarity: fakeClarity });
    s.addTarget('ja');
    const script = DEMO_MEETING.lines.slice(0, 3).map((l, i) => ({ at: i * 0.05, text: l.text, speakerId: l.speaker, lang: l.lang, confidence: l.confidence }));
    const partials: string[] = [];
    s.on('partial', p => { if (p.partial) partials.push(p.partial.text); });
    await s.attach('system', new ScriptedSpeechProvider(script, { wordMs: 1, gapMs: 5, tailMs: 5 }), { diarize: true });
    await new Promise(r => setTimeout(r, 400));
    expect(s.lines.map(l => l.speaker.name)).toEqual(['Guest 1', 'Guest 2', 'Guest 3']);
    expect(partials.length).toBeGreaterThan(3);
    await new Promise(r => setTimeout(r, 200));
    // Mandarin and Japanese lines get English; English and Mandarin lines get Japanese.
    expect(s.lines[0]!.tr.en).toMatch(/^\[en\]/);
    expect(s.lines[1]!.tr.en).toBeUndefined();
    expect(s.lines[1]!.tr.ja).toMatch(/^\[ja\]/);
    expect(s.lines[2]!.tr.ja).toBeUndefined();
    expect(fakeClarity.summarize).toHaveBeenCalled();
    await s.stop();
    const note = s.toNote();
    expect(note.title).toBe('Launch sync');
    expect(note.languages.sort()).toEqual(['en', 'ja', 'zh']);
    expect(note.clarity?.summary[0]?.text.en).toBe('3 lines');
  });

  it('marks failed translations and retries them', async () => {
    const translator = new FakeTranslator();
    const s = new LiveSession({ me: { id: 'me', name: 'Alex', self: true }, myLang: 'en', candidateLanguages: ['en', 'zh'], autoClarityEvery: 0 }, { translator });
    const errors: string[] = [];
    s.on('error', e => errors.push(e.source));
    translator.failNext = true;
    const line = s.addLine({ t: 1, speaker: { id: 'li', name: 'Li Wei' }, channel: 'remote', text: '没问题', lang: 'zh' });
    await new Promise(r => setTimeout(r, 250));
    expect(errors).toEqual(['translate']);
    expect(s.isFailed(line.id, 'en')).toBe(true);
    s.retry(line.id, 'en');
    await new Promise(r => setTimeout(r, 250));
    expect(line.tr.en).toBe('[en] 没问题');
    s.dispose();
  });

  it('lets an engine without language detection be corrected by the translator', async () => {
    const translator = new FakeTranslator();
    const s = new LiveSession({ me: { id: 'me', name: 'Alex', self: true }, myLang: 'ja', candidateLanguages: ['en', 'zh'], autoClarityEvery: 0 }, { translator });
    const line = s.addLine({ t: 0, speaker: { id: 'x', name: 'X' }, channel: 'mic', text: '我们开始吧', lang: 'en' }, false);
    await new Promise(r => setTimeout(r, 250));
    expect(line.lang).toBe('zh');
    expect(line.confidence).toBe(0.9);
    s.dispose();
  });
});

describe('demo engines', () => {
  it('serve baked translations and growing notes without any API key', async () => {
    const { DemoTranslator, DemoClarity } = await import('../src/demo.js');
    const s = new LiveSession({ me: { id: 'me', name: 'Alex', self: true }, myLang: 'ja', candidateLanguages: [], autoClarityEvery: 0 },
                              { translator: new DemoTranslator(), clarity: new DemoClarity() });
    DEMO_MEETING.lines.forEach((l, i) => s.addLine({ t: l.t, speaker: { id: l.speaker, name: l.speaker }, channel: 'demo', text: l.text, lang: l.lang, ...(l.langs ? { langs: l.langs } : {}), confidence: l.confidence, id: `d${i + 1}` }));
    await new Promise(r => setTimeout(r, 300));
    expect(s.lines[1]!.tr.ja).toContain('シンガポール側は準備ができています');
    await s.stop();
    expect(s.title).toBe(DEMO_MEETING.title);
    expect(s.clarity?.actions).toHaveLength(5);
    expect(s.clarity?.actions.find(a => a.ownerIsMe)?.lineId).toBe('d8');
    expect(s.clarity?.followup?.text.ja).toBe('パッケージ最終確認');
  });
});
