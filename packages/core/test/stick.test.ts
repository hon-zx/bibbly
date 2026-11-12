import { describe, expect, it } from 'vitest';
import { encodeWavIma } from '../src/audio/wav.js';
import { StickClient, type StickTransport } from '../src/stick/client.js';
import { Cmd, crc32, encodeFrame, Evt, FrameParser, FrameType, Reader, Status, utf8Fallback, Writer } from '../src/stick/protocol.js';
import { sine, toInt16 } from './helpers.js';

describe('link framing', () => {
  it('decodes UTF-8 without TextDecoder', () => {
    for (const text of ['0.1.0-sim', 'Bibbly café', '会议记录', 'emoji 🙂 ok']) {
      expect(utf8Fallback(new TextEncoder().encode(text))).toBe(text);
    }
    expect(utf8Fallback(Uint8Array.of(0x61, 0xe4, 0xbc))).toBe('a\ufffd');
  });
  it('uses the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('round-trips frames across arbitrary chunking and skips garbage', () => {
    const a = encodeFrame({ type: FrameType.Request, code: Cmd.Ping, seq: 7, payload: new Uint8Array(0) });
    const b = encodeFrame({ type: FrameType.Event, code: Evt.Button, seq: 0, payload: Uint8Array.of(3) });
    const corrupt = encodeFrame({ type: FrameType.Event, code: Evt.Button, seq: 1, payload: Uint8Array.of(1) });
    corrupt[corrupt.length - 1]! ^= 0xff;
    const stream = Uint8Array.from([0x00, 0x42, 0x13, ...a, ...corrupt, 0x42, ...b]);
    const p = new FrameParser();
    const frames = [];
    for (let i = 0; i < stream.length; i += 5) frames.push(...p.push(stream.subarray(i, i + 5)));
    expect(frames.map(f => [f.code, f.seq])).toEqual([[Cmd.Ping, 7], [Evt.Button, 0]]);
    expect(p.dropped).toBeGreaterThan(0);
  });
});

/** In-memory Stick that answers like the firmware (the C simulator test covers the real thing). */
function fakeStick(file: Uint8Array): StickTransport & { events(code: number, payload: Uint8Array): void } {
  let sink: (b: Uint8Array) => void = () => {};
  const parser = new FrameParser();
  const reply = (code: number, seq: number, status: number, body: Uint8Array = new Uint8Array(0)) =>
    setTimeout(() => sink(encodeFrame({ type: FrameType.Response, code, seq, payload: Uint8Array.from([status, ...body]) })), 1);
  return {
    async write(bytes) {
      for (const f of parser.push(bytes)) {
        const r = new Reader(f.payload);
        if (f.code === Cmd.Ping) reply(f.code, f.seq, Status.Ok, new Writer().u32(1234).done());
        else if (f.code === Cmd.List) reply(f.code, f.seq, Status.Ok, new Writer().u16(1).u8(1).u16(3).u32(file.length).u64(1_794_470_400_000).u32(2000).u8(0).u8(0).done());
        else if (f.code === Cmd.Read) {
          const id = r.u16(), off = r.u32(), len = r.u16();
          if (id !== 3) reply(f.code, f.seq, Status.NotFound);
          else reply(f.code, f.seq, Status.Ok, Uint8Array.from([...new Writer().u16(id).u32(off).done(), ...file.subarray(off, off + len)]));
        } else reply(f.code, f.seq, Status.Unsupported);
      }
    },
    onData(cb) { sink = cb; return () => { sink = () => {}; }; },
    events(code, payload) { sink(encodeFrame({ type: FrameType.Event, code, seq: 0, payload })); },
  };
}

describe('StickClient', () => {
  it('lists and downloads a recording in chunks', async () => {
    const wav = encodeWavIma(toInt16(sine(300, 16_000, 2)), 16_000, 1_794_470_400_000);
    const dev = fakeStick(wav);
    const client = new StickClient(dev);
    expect(await client.ping()).toBe(1234);
    const [rec] = await client.list();
    expect(rec).toMatchObject({ id: 3, size: wav.length, durationMs: 2000, synced: false });
    const progress: number[] = [];
    const decoded = await client.readDecoded(rec!, p => progress.push(p));
    expect(decoded.samples.length).toBe(32_000);
    expect(decoded.stick?.startEpochMs).toBe(1_794_470_400_000);
    expect(progress.at(-1)).toBe(1);
    await expect(client.remove(99)).rejects.toThrow(/does not support/);
    const seen: number[] = [];
    client.on('button', e => seen.push(e.gesture));
    dev.events(Evt.Button, Uint8Array.of(3));
    expect(seen).toEqual([3]);
    await client.close();
  });
});
