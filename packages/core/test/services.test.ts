import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { FRAME_SAMPLES } from '../src/audio/pcm.js';
import { Claude, ClaudeRefusalError, DEFAULT_CLAUDE_MODEL } from '../src/llm/claude.js';
import { parseClientMsg, parseServerMsg, RoomClient } from '../src/session/room.js';
import type { SpeechResult } from '../src/speech/provider.js';
import { WhisperSpeechProvider } from '../src/speech/whisper.js';
import { bursts } from './helpers.js';

/** Fake Anthropic client that records requests and returns canned JSON. */
function fakeClient(answers: (params: Record<string, unknown>) => { stop_reason: string; text?: string; stop_details?: unknown }) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: { messages: { create: async (params: Record<string, unknown>) => {
      calls.push(params);
      const a = answers(params);
      return { stop_reason: a.stop_reason, stop_details: a.stop_details ?? null, content: a.text ? [{ type: 'text', text: a.text }] : [] };
    } } },
  } as unknown as Anthropic;
  return { client, calls };
}

describe('Claude service', () => {
  it('translates with the default model, low effort, structured output and refusal fallbacks', async () => {
    const { client, calls } = fakeClient(() => ({ stop_reason: 'end_turn', text: JSON.stringify({ items: [{ id: 'l1', lang: 'zh-CN', langs: ['zh', 'en'], confidence: 1.4, translation: 'We lock both dates.' }, { id: 'zz', lang: 'en', langs: [], confidence: 1, translation: 'not asked' }] }) }));
    const claude = new Claude({ client });
    const out = await claude.translate({ target: 'en', items: [{ id: 'l1', text: '我们 lock 两个日期', speaker: 'Jun' }], context: ['Li Wei: 大家好'], glossary: ['Nimbus Lite'] });
    expect(out).toEqual([{ id: 'l1', translation: 'We lock both dates.', lang: 'zh', langs: ['zh', 'en'], confidence: 1 }]);
    const p = calls[0]!;
    expect(p.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(DEFAULT_CLAUDE_MODEL).toBe('claude-opus-5-5');
    expect(p.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(p.fallbacks).toBe('default');
    expect(p.output_config).toMatchObject({ effort: 'low', format: { type: 'json_schema' } });
    expect(p.speed).toBeUndefined();
    expect(JSON.parse((p.messages as { content: string }[])[0]!.content)).toMatchObject({ target_language: 'English (en)', glossary: ['Nimbus Lite'] });
  });

  it('uses fast mode only when asked and surfaces refusals', async () => {
    const { client, calls } = fakeClient(() => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' } }));
    const claude = new Claude({ client, fast: true, model: 'claude-sonnet-5-5' });
    await expect(claude.translate({ target: 'en', items: [{ id: 'a', text: 'x' }] })).rejects.toBeInstanceOf(ClaudeRefusalError);
    expect(calls[0]).toMatchObject({ speed: 'fast', model: 'claude-sonnet-5-5' });
  });

  it('turns the notes into dated, owned action items', async () => {
    const { client, calls } = fakeClient(() => ({ stop_reason: 'end_turn', text: JSON.stringify({
      title: 'Q4 launch sync', summary: ['Dates locked'], decisions: ['SG Nov 28'],
      actions: [{ owner: 'Alex', owner_is_me: true, task: 'Get finance sign-off', due_date: '2026-11-13', due_time: '17:00', line_id: 'd8' },
                { owner: 'Li Wei', owner_is_me: false, task: 'Send files', due_date: null, due_time: null, line_id: null }],
      followup: { title: 'Packaging review', date: '2026-11-17', time: '10:00', duration_min: 45 } }) }));
    const res = await new Claude({ client }).summarize({ lang: 'en', me: 'Alex', startedAt: Date.now(), final: true, lines: [{ id: 'd8', t: 150, speaker: 'Alex (me)', text: '…' }] });
    expect(calls[0]!.output_config).toMatchObject({ effort: 'high' });
    expect(res.title).toBe('Q4 launch sync');
    expect(res.clarity.actions[0]).toMatchObject({ ownerIsMe: true, lineId: 'd8', due: new Date(2026, 10, 13, 17, 0).getTime(), text: { en: 'Get finance sign-off' } });
    expect(res.clarity.actions[1]!.due).toBeNull();
    expect(res.clarity.followup).toMatchObject({ when: new Date(2026, 10, 17, 10, 0).getTime(), durationMin: 45 });
  });

  it('refines multilingual tasks', async () => {
    const { client } = fakeClient(() => ({ stop_reason: 'end_turn', text: JSON.stringify({ title: '给李伟发报价', date: '2026-11-13', time: '15:00', remind: false, list: 'Work' }) }));
    const t = await new Claude({ client }).refine('明天下午三点给李伟发报价', new Date(2026, 10, 12, 9).getTime());
    expect(t).toEqual({ title: '给李伟发报价', due: new Date(2026, 10, 13, 15, 0).getTime(), remind: true, list: 'Work' });
  });
});

describe('Whisper-compatible provider', () => {
  it('transcribes each utterance and maps the detected language', async () => {
    const bodies: FormData[] = [];
    const fakeFetch = (async (_url: string, init: { body: FormData }) => {
      bodies.push(init.body);
      return new Response(JSON.stringify({ text: ' 没问题，我们开始吧 ', language: 'chinese' }), { status: 200 });
    }) as unknown as typeof fetch;
    const stream = await new WhisperSpeechProvider({ baseUrl: 'http://localhost:9', fetch: fakeFetch }).start({ sampleRate: 16_000, candidateLanguages: ['en', 'zh'], phrases: ['Nimbus Lite'] });
    const results: SpeechResult[] = [];
    stream.onResult(r => results.push(r));
    const pcm = bursts(16_000, [[0.8, 1], [0.8, 1]]);
    for (let i = 0; i < pcm.length; i += FRAME_SAMPLES * 5) stream.write(pcm.subarray(i, i + FRAME_SAMPLES * 5));
    await stream.close();
    const finals = results.filter(r => r.final);
    expect(finals).toHaveLength(2);
    expect(finals[0]).toMatchObject({ text: '没问题，我们开始吧', lang: 'zh' });
    expect(results.some(r => !r.final)).toBe(true);
    expect(bodies[0]!.get('response_format')).toBe('verbose_json');
    expect(bodies[0]!.get('prompt')).toBe('Nimbus Lite');
  });
});

describe('room protocol', () => {
  it('validates untrusted messages', () => {
    expect(parseClientMsg(JSON.stringify({ t: 'hello', v: 1, room: 'abc234', role: 'listener', name: 'Mei‮', lang: 'zh' }))).toEqual({ t: 'hello', v: 1, room: 'abc234', role: 'listener', name: 'Mei', lang: 'zh' });
    expect(parseClientMsg(JSON.stringify({ t: 'hello', room: 'ABC!', role: 'listener', lang: 'zh' }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'lang', lang: 'klingon' }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'caption', line: { id: 'l1', t: 3, speaker: 'Li', text: 'x'.repeat(5000), lang: 'zh' } }))).toMatchObject({ line: { text: 'x'.repeat(2000) } });
    expect(parseClientMsg('{not json')).toBeNull();
    expect(parseServerMsg(JSON.stringify({ t: 'translation', id: 'l1', lang: 'ja', text: 'こんにちは' }))).toEqual({ t: 'translation', id: 'l1', lang: 'ja', text: 'こんにちは' });
  });

  it('says hello on connect and reconnects after a drop', async () => {
    const sockets: { sent: string[]; ws: FakeWs }[] = [];
    class FakeWs {
      readyState = 0; onopen: ((e: unknown) => void) | null = null; onclose: ((e: unknown) => void) | null = null;
      onmessage: ((e: { data: unknown }) => void) | null = null; onerror: ((e: unknown) => void) | null = null;
      sent: string[] = [];
      constructor() { sockets.push({ sent: this.sent, ws: this }); setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 1); }
      send(d: string) { this.sent.push(d); }
      close() { this.readyState = 3; this.onclose?.({}); }
    }
    const c = new RoomClient('ws://x', { room: 'abc234', role: 'listener', name: 'Mei', lang: 'zh' }, FakeWs as never);
    const got: string[] = [];
    c.on('message', m => got.push(m.t));
    c.connect();
    await new Promise(r => setTimeout(r, 10));
    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({ t: 'hello', room: 'abc234', lang: 'zh', v: 1 });
    sockets[0]!.ws.onmessage?.({ data: JSON.stringify({ t: 'ended' }) });
    expect(got).toEqual(['ended']);
    sockets[0]!.ws.readyState = 3;
    sockets[0]!.ws.onclose?.({});
    await new Promise(r => setTimeout(r, 1100));
    expect(sockets.length).toBe(2);
    c.close();
  });
});
