import { decodeWav, type DecodedWav } from '../audio/wav.js';
import { Emitter } from '../util.js';
import {
  Cmd, encodeFrame, Evt, FrameParser, FrameType, Reader, Status, Writer, LINK_MAX_PAYLOAD, type Frame,
} from './protocol.js';

/** Anything that moves bytes to and from the Stick: WebUSB, node-usb, a serial port, or the host simulator. */
export interface StickTransport {
  write(bytes: Uint8Array): Promise<void>;
  /** Registers the byte sink; returns an unsubscribe function. */
  onData(cb: (bytes: Uint8Array) => void): () => void;
  close?(): Promise<void>;
}

export interface StickInfo { protocol: number; hardware: number; firmware: string; serial: string; flashKb: number; caps: number; }
export interface StickStatus {
  state: number; batteryPct: number | null; charging: boolean; mode: number;
  freeKb: number; totalKb: number; recordings: number; micLevelDb: number; recordingMs: number;
  /** StatusFlags bits; 0 from firmware that doesn't send them. */
  flags: number;
}
export interface StickRecording { id: number; size: number; startEpochMs: number; durationMs: number; synced: boolean; }

export type StickEvents = {
  button: { gesture: number };
  state: { state: number; recordingId: number };
  battery: { pct: number | null; charging: boolean };
  error: { message: string };
};

export class StickError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'StickError'; }
}

const STATUS_TEXT: Record<number, string> = {
  [Status.BadRequest]: 'The Stick rejected the request', [Status.NotFound]: 'That recording is no longer on the Stick',
  [Status.Busy]: 'The Stick is busy', [Status.IoError]: 'The Stick could not read its storage', [Status.Unsupported]: 'This firmware does not support that',
};

/** Talks to a Bibbly Stick over any byte transport, with request/response matching and events. */
export class StickClient extends Emitter<StickEvents> {
  private seq = 0;
  private readonly parser = new FrameParser();
  private readonly pending = new Map<number, { code: number; resolve: (r: Reader) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly unsubscribe: () => void;

  constructor(private readonly transport: StickTransport, private readonly timeoutMs = 3000) {
    super();
    this.unsubscribe = transport.onData(bytes => this.onBytes(bytes));
  }

  private onBytes(bytes: Uint8Array) {
    for (const f of this.parser.push(bytes)) this.onFrame(f);
  }

  private onFrame(f: Frame) {
    if (f.type === FrameType.Event) {
      const r = new Reader(f.payload);
      try {
        if (f.code === Evt.Button) this.emit('button', { gesture: r.u8() });
        else if (f.code === Evt.State) this.emit('state', { state: r.u8(), recordingId: r.u16() });
        else if (f.code === Evt.Battery) { const pct = r.u8(); this.emit('battery', { pct: pct === 255 ? null : pct, charging: r.u8() === 1 }); }
      } catch { this.emit('error', { message: 'Malformed event from the Stick' }); }
      return;
    }
    if (f.type !== FrameType.Response) return;
    const p = this.pending.get(f.seq);
    if (!p || p.code !== f.code) return;
    this.pending.delete(f.seq);
    clearTimeout(p.timer);
    const r = new Reader(f.payload);
    const status = f.payload.length ? r.u8() : Status.BadRequest;
    if (status === Status.Ok) p.resolve(r);
    else p.reject(new StickError(STATUS_TEXT[status] ?? `Stick error ${status}`, status));
  }

  request(code: number, payload: Uint8Array = new Uint8Array(0)): Promise<Reader> {
    const seq = (this.seq = (this.seq + 1) & 0xff);
    return new Promise<Reader>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new StickError('The Stick did not answer in time')); }, this.timeoutMs);
      this.pending.set(seq, { code, resolve, reject, timer });
      this.transport.write(encodeFrame({ type: FrameType.Request, code, seq, payload })).catch(err => {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(err instanceof Error ? err : new StickError(String(err)));
      });
    });
  }

  async ping(): Promise<number> { return (await this.request(Cmd.Ping)).u32(); }

  async info(): Promise<StickInfo> {
    const r = await this.request(Cmd.Info);
    const protocol = r.u16(), hardware = r.u16(), firmware = r.str(16);
    const serial = [...r.bytes(8)].map(b => b.toString(16).padStart(2, '0')).join('');
    return { protocol, hardware, firmware, serial, flashKb: r.u32(), caps: r.u32() };
  }

  async status(): Promise<StickStatus> {
    const r = await this.request(Cmd.Status);
    const state = r.u8(), battery = r.u8(), charging = r.u8() === 1, mode = r.u8();
    const freeKb = r.u32(), totalKb = r.u32(), recordings = r.u16(), micLevelDb = r.i16() / 10, recordingMs = r.u32();
    return { state, batteryPct: battery === 255 ? null : battery, charging, mode, freeKb, totalKb, recordings, micLevelDb,
             recordingMs, flags: r.remaining ? r.u8() : 0 };
  }

  async list(): Promise<StickRecording[]> {
    const out: StickRecording[] = [];
    for (let start = 0; ; ) {
      const r = await this.request(Cmd.List, new Writer().u16(start).u16(32).done());
      const total = r.u16();
      const count = r.u8();
      for (let i = 0; i < count; i++) {
        const id = r.u16(), size = r.u32(), startEpochMs = r.u64(), durationMs = r.u32(), flags = r.u8();
        r.u8();
        out.push({ id, size, startEpochMs, durationMs, synced: (flags & 1) === 1 });
      }
      start += count;
      if (count === 0 || start >= total) break;
    }
    return out;
  }

  /** Downloads a whole recording in chunks; `onProgress` gets 0..1. */
  async read(rec: StickRecording, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
    const chunk = LINK_MAX_PAYLOAD - 16;
    const out = new Uint8Array(rec.size);
    for (let offset = 0; offset < rec.size; ) {
      if (signal?.aborted) throw new StickError('Import cancelled');
      const len = Math.min(chunk, rec.size - offset);
      const r = await this.request(Cmd.Read, new Writer().u16(rec.id).u32(offset).u16(len).done());
      const id = r.u16(), at = r.u32();
      const data = r.rest();
      if (id !== rec.id || at !== offset || data.length === 0) throw new StickError('The Stick sent the wrong part of the recording');
      out.set(data.subarray(0, rec.size - offset), offset);
      offset += data.length;
      onProgress?.(Math.min(1, offset / rec.size));
    }
    return out;
  }

  async readDecoded(rec: StickRecording, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<DecodedWav> {
    return decodeWav(await this.read(rec, onProgress, signal));
  }

  async remove(id: number): Promise<void> { await this.request(Cmd.Delete, new Writer().u16(id).done()); }
  async markSynced(id: number): Promise<void> { await this.request(Cmd.MarkSynced, new Writer().u16(id).done()); }
  async setTime(epochMs: number = Date.now()): Promise<void> { await this.request(Cmd.SetTime, new Writer().u64(epochMs).done()); }
  async setMode(mode: number): Promise<number> { return (await this.request(Cmd.SetMode, new Writer().u8(mode).done())).u8(); }
  async record(start: boolean): Promise<{ state: number; id: number }> {
    const r = await this.request(Cmd.Record, new Writer().u8(start ? 1 : 0).done());
    return { state: r.u8(), id: r.u16() };
  }
  async ledTest(pattern: number): Promise<void> { await this.request(Cmd.LedTest, new Writer().u8(pattern).done()); }

  async close(): Promise<void> {
    this.unsubscribe();
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new StickError('Disconnected')); }
    this.pending.clear();
    await this.transport.close?.();
  }
}
