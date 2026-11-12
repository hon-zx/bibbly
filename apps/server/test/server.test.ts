import type { ServerMsg, TranslateRequest, Translator } from '@bibbly/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startServer, type RunningServer } from '../src/server.js';

class CountingTranslator implements Translator {
  calls: TranslateRequest[] = [];
  async translate(req: TranslateRequest) {
    this.calls.push(req);
    return req.items.map(i => ({ id: i.id, translation: `${req.target}:${i.text}`, lang: null, langs: [], confidence: null }));
  }
}

function client(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox: ServerMsg[] = [];
  ws.on('message', d => inbox.push(JSON.parse(d.toString()) as ServerMsg));
  const opened = new Promise<void>(res => ws.on('open', () => res()));
  return {
    ws, inbox, opened,
    send: (m: object) => ws.send(JSON.stringify(m)),
    waitFor: async (pred: (m: ServerMsg) => boolean, ms = 2000) => {
      const start = Date.now();
      while (Date.now() - start < ms) { const hit = inbox.find(pred); if (hit) return hit; await new Promise(r => setTimeout(r, 15)); }
      throw new Error('timed out waiting for message; inbox: ' + JSON.stringify(inbox.map(m => m.t)));
    },
  };
}

describe('rooms server', () => {
  let server: RunningServer;
  const translator = new CountingTranslator();
  beforeAll(async () => { server = await startServer({ port: 0, host: '127.0.0.1', translator }); });
  afterAll(async () => { await server.close(); });

  it('serves the guest page and health check', async () => {
    const page = await fetch(`http://127.0.0.1:${server.port}/join/abc234`).then(r => r.text());
    expect(page).toContain('Follow this meeting in your language');
    expect(page).toContain('"abc234"');
    expect(await fetch(`http://127.0.0.1:${server.port}/join/../../etc`).then(r => r.status)).toBe(404);
    expect(await fetch(`http://127.0.0.1:${server.port}/healthz`).then(r => r.json())).toMatchObject({ ok: true, translation: true });
  });

  it('translates once per listener language and catches up late joiners', async () => {
    const host = client(server.port);
    await host.opened;
    host.send({ t: 'hello', v: 1, room: 'abc234', role: 'host', name: 'Alex', lang: 'en', key: 'secret' });
    await host.waitFor(m => m.t === 'welcome');

    const en1 = client(server.port), en2 = client(server.port), zh = client(server.port);
    await Promise.all([en1.opened, en2.opened, zh.opened]);
    en1.send({ t: 'hello', v: 1, room: 'abc234', role: 'listener', name: 'Jun', lang: 'en' });
    en2.send({ t: 'hello', v: 1, room: 'abc234', role: 'listener', name: 'Priya', lang: 'en' });
    zh.send({ t: 'hello', v: 1, room: 'abc234', role: 'listener', name: 'Li Wei', lang: 'zh' });
    await Promise.all([en1.waitFor(m => m.t === 'welcome'), en2.waitFor(m => m.t === 'welcome'), zh.waitFor(m => m.t === 'welcome')]);

    host.send({ t: 'caption', line: { id: 'l1', t: 3, speaker: 'Sato', text: '日本は少し遅れそうです', lang: 'ja' } });
    await en1.waitFor(m => m.t === 'translation' && m.id === 'l1');
    await en2.waitFor(m => m.t === 'translation' && m.id === 'l1');
    const zhTr = await zh.waitFor(m => m.t === 'translation' && m.id === 'l1');
    expect(zhTr).toMatchObject({ lang: 'zh', text: 'zh:日本は少し遅れそうです' });
    expect(zh.inbox.some(m => m.t === 'translation' && m.lang === 'en')).toBe(false);
    // Two English listeners share one translation request.
    const forL1 = translator.calls.filter(c => c.items.some(i => i.id === 'l1'));
    expect(forL1.map(c => c.target).sort()).toEqual(['en', 'zh']);

    const ja = client(server.port);
    await ja.opened;
    ja.send({ t: 'hello', v: 1, room: 'abc234', role: 'listener', name: 'Tanaka', lang: 'ja' });
    const welcome = await ja.waitFor(m => m.t === 'welcome');
    expect(welcome.t === 'welcome' && welcome.history.map(l => l.id)).toEqual(['l1']);
    // Already Japanese: no translation needed for this listener.
    await new Promise(r => setTimeout(r, 200));
    expect(ja.inbox.some(m => m.t === 'translation')).toBe(false);

    zh.send({ t: 'lang', lang: 'es' });
    await zh.waitFor(m => m.t === 'translation' && m.lang === 'es');

    for (const c of [host, en1, en2, zh, ja]) c.ws.close();
  });

  it('protects the host role and rejects junk', async () => {
    const host = client(server.port);
    await host.opened;
    host.send({ t: 'hello', v: 1, room: 'room99', role: 'host', name: 'A', lang: 'en', key: 'k1' });
    await host.waitFor(m => m.t === 'welcome');
    const imposter = client(server.port);
    await imposter.opened;
    imposter.send({ t: 'hello', v: 1, room: 'room99', role: 'host', name: 'B', lang: 'en', key: 'nope' });
    expect(await imposter.waitFor(m => m.t === 'error')).toMatchObject({ code: 'not_host' });
    const listener = client(server.port);
    await listener.opened;
    listener.send({ t: 'hello', v: 1, room: 'room99', role: 'listener', name: 'C', lang: 'en' });
    await listener.waitFor(m => m.t === 'welcome');
    listener.send({ t: 'caption', line: { id: 'x', t: 0, speaker: 'C', text: 'fake', lang: 'en' } });
    expect(await listener.waitFor(m => m.t === 'error')).toMatchObject({ code: 'not_host' });
    listener.ws.send('not json');
    expect(await listener.waitFor(m => m.t === 'error' && m.code === 'bad_message')).toBeTruthy();
    const lost = client(server.port);
    await lost.opened;
    lost.send({ t: 'hello', v: 1, room: 'nosuch1', role: 'listener', name: 'D', lang: 'en' });
    expect(await lost.waitFor(m => m.t === 'error')).toMatchObject({ code: 'no_room' });
    host.send({ t: 'end' });
    await listener.waitFor(m => m.t === 'ended');
    for (const c of [host, imposter, listener, lost]) c.ws.close();
  });
});
