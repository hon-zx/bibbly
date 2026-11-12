/**
 * Bibbly Stick link protocol (v1), shared with the firmware in
 * firmware/bibbly-stick/components/stick_core/include/stick_link.h.
 *
 * Frame: "BB" | ver u8 | type u8 | code u8 | seq u8 | len u16 LE | payload | crc32 u32 LE
 * The CRC (IEEE 802.3) covers ver..payload. Integers are little-endian.
 * Response payloads start with a status byte.
 */
export const LINK_MAGIC = 0x4242;
export const LINK_VERSION = 1;
export const LINK_HEADER = 8;
export const LINK_OVERHEAD = 12;
export const LINK_MAX_PAYLOAD = 4096;

export const FrameType = { Request: 1, Response: 2, Event: 3 } as const;
export const Cmd = {
  Ping: 0x01, Info: 0x02, Status: 0x03, List: 0x04, Read: 0x05, Delete: 0x06,
  SetTime: 0x07, SetMode: 0x08, Record: 0x09, LedTest: 0x0a, MarkSynced: 0x0b,
} as const;
export const Evt = { Button: 0x81, State: 0x82, Battery: 0x83 } as const;
export const Status = { Ok: 0, BadRequest: 1, NotFound: 2, Busy: 3, IoError: 4, Unsupported: 5 } as const;
export const DeviceState = { Idle: 0, Streaming: 1, Recording: 2, Syncing: 3, LowBattery: 4, Error: 5 } as const;
export const DeviceMode = { MeetingMic: 0, PocketRecorder: 1, Room: 2 } as const;
export const Gesture = { Short: 1, Double: 2, Long: 3 } as const;
/** Info.caps bits. */
export const Caps = { UsbMic: 1, Hid: 2, Ble: 4, Encrypted: 8, Battery: 16 } as const;
/** Status.flags bits (a trailing byte that older firmware may omit). */
export const StatusFlags = { Muted: 1, ClockSet: 2, Encrypted: 4, Usb: 8, NoStorage: 16 } as const;

export const STATE_NAMES = ['Idle', 'Streaming', 'Recording', 'Syncing', 'Low battery', 'Error'] as const;
export const MODE_NAMES = ['Meeting mic', 'Pocket recorder', 'Room mode'] as const;

export interface Frame { type: number; code: number; seq: number; payload: Uint8Array; }

let CRC_TABLE: Uint32Array | null = null;
export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodeFrame(f: Frame): Uint8Array {
  if (f.payload.length > LINK_MAX_PAYLOAD) throw new RangeError('payload too large');
  const buf = new Uint8Array(LINK_OVERHEAD + f.payload.length);
  const v = new DataView(buf.buffer);
  buf[0] = 0x42; buf[1] = 0x42; buf[2] = LINK_VERSION; buf[3] = f.type; buf[4] = f.code; buf[5] = f.seq & 0xff;
  v.setUint16(6, f.payload.length, true);
  buf.set(f.payload, LINK_HEADER);
  v.setUint32(LINK_HEADER + f.payload.length, crc32(buf, 2, LINK_HEADER + f.payload.length), true);
  return buf;
}

/** Incremental frame parser: resynchronises on the magic bytes and drops corrupt frames. */
export class FrameParser {
  private buf = new Uint8Array(0);
  public dropped = 0;

  push(chunk: Uint8Array): Frame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    const out: Frame[] = [];
    for (;;) {
      let i = 0;
      while (i + 1 < this.buf.length && !(this.buf[i] === 0x42 && this.buf[i + 1] === 0x42)) i++;
      if (i > 0) { this.buf = this.buf.slice(i); this.dropped += i; }
      if (this.buf.length < LINK_HEADER) break;
      const v = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const len = v.getUint16(6, true);
      if (this.buf[2] !== LINK_VERSION || len > LINK_MAX_PAYLOAD) { this.buf = this.buf.slice(1); this.dropped++; continue; }
      if (this.buf.length < LINK_OVERHEAD + len) break;
      const crc = v.getUint32(LINK_HEADER + len, true);
      if (crc !== crc32(this.buf, 2, LINK_HEADER + len)) { this.buf = this.buf.slice(1); this.dropped++; continue; }
      out.push({ type: this.buf[3]!, code: this.buf[4]!, seq: this.buf[5]!, payload: this.buf.slice(LINK_HEADER, LINK_HEADER + len) });
      this.buf = this.buf.slice(LINK_OVERHEAD + len);
    }
    return out;
  }
}

/** Little-endian payload writer/reader helpers. */
export class Writer {
  private bytes: number[] = [];
  u8(v: number) { this.bytes.push(v & 0xff); return this; }
  u16(v: number) { this.bytes.push(v & 0xff, (v >>> 8) & 0xff); return this; }
  u32(v: number) { this.u16(v & 0xffff); this.u16((v >>> 16) & 0xffff); return this; }
  u64(v: number) { this.u32(v % 2 ** 32); this.u32(Math.floor(v / 2 ** 32)); return this; }
  done(): Uint8Array { return Uint8Array.from(this.bytes); }
}
export class Reader {
  private o = 0;
  private readonly v: DataView;
  constructor(private readonly b: Uint8Array) { this.v = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  get remaining(): number { return this.b.length - this.o; }
  private need(n: number) { if (this.o + n > this.b.length) throw new RangeError('payload too short'); }
  u8(): number { this.need(1); return this.b[this.o++]!; }
  i16(): number { this.need(2); const x = this.v.getInt16(this.o, true); this.o += 2; return x; }
  u16(): number { this.need(2); const x = this.v.getUint16(this.o, true); this.o += 2; return x; }
  u32(): number { this.need(4); const x = this.v.getUint32(this.o, true); this.o += 4; return x; }
  u64(): number { const lo = this.u32(); const hi = this.u32(); return hi * 2 ** 32 + lo; }
  bytes(n: number): Uint8Array { this.need(n); const x = this.b.slice(this.o, this.o + n); this.o += n; return x; }
  rest(): Uint8Array { return this.bytes(this.remaining); }
  str(n: number): string { const raw = this.bytes(n); const end = raw.indexOf(0); return utf8(end >= 0 ? raw.subarray(0, end) : raw); }
}

/** UTF-8 decoding that also works where TextDecoder is missing (some React Native engines). */
export function utf8(b: Uint8Array): string {
  return typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(b) : utf8Fallback(b);
}

/** Minimal UTF-8 decoder; malformed or truncated sequences become U+FFFD. */
export function utf8Fallback(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i]!;
    const n = c < 0x80 ? 0 : c >= 0xf0 ? 3 : c >= 0xe0 ? 2 : c >= 0xc0 ? 1 : -1;
    if (n < 0 || i + n >= b.length + (n ? 0 : 1)) { out += n === 0 ? String.fromCharCode(c) : '\ufffd'; i += n === 0 ? 1 : Math.max(1, b.length - i); continue; }
    let cp = n === 0 ? c : c & (0x3f >> n);
    for (let k = 1; k <= n; k++) cp = (cp << 6) | (b[i + k]! & 0x3f);
    out += String.fromCodePoint(cp);
    i += n + 1;
  }
  return out;
}
