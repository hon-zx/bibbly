import { decodeImaBlock, encodeIma, samplesPerBlock } from './adpcm.js';

export interface DecodedWav {
  sampleRate: number;
  channels: number;
  samples: Int16Array;
  /** Present in recordings made by the Bibbly Stick ("bbly" chunk). */
  stick?: { startEpochMs: number; flags: number };
}

const ascii = (b: Uint8Array, o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

/** 16-bit PCM WAV (what speech APIs expect for uploaded audio). */
export function encodeWavPcm16(samples: Int16Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const data = samples.length * 2;
  const buf = new Uint8Array(44 + data);
  const v = new DataView(buf.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < 4; i++) buf[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); v.setUint32(4, 36 + data, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, data, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, samples[i]!, true);
  return buf;
}

/** IMA ADPCM WAV with fact and bbly chunks, byte-identical to the Stick's recorder. */
export function encodeWavIma(samples: Int16Array, sampleRate: number, startEpochMs = 0, blockAlign = 512): Uint8Array {
  const payload = encodeIma(samples, blockAlign);
  const spb = samplesPerBlock(blockAlign);
  const headerLen = 12 + 28 + 12 + 20 + 8;
  const buf = new Uint8Array(headerLen + payload.length);
  const v = new DataView(buf.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < 4; i++) buf[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); v.setUint32(4, buf.length - 8, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 20, true); v.setUint16(20, 0x11, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, Math.round((sampleRate * blockAlign) / spb), true);
  v.setUint16(32, blockAlign, true); v.setUint16(34, 4, true); v.setUint16(36, 2, true); v.setUint16(38, spb, true);
  w(40, 'fact'); v.setUint32(44, 4, true); v.setUint32(48, samples.length, true);
  w(52, 'bbly'); v.setUint32(56, 12, true); v.setUint32(60, 1, true);
  v.setUint32(64, startEpochMs % 2 ** 32, true); v.setUint32(68, Math.floor(startEpochMs / 2 ** 32), true);
  w(72, 'data'); v.setUint32(76, payload.length, true);
  buf.set(payload, headerLen);
  return buf;
}

/** Parses PCM16 and IMA ADPCM WAV files, including the Stick's bbly chunk. */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  if (bytes.length < 12 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WAVE') throw new Error('not a WAV file');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt: { tag: number; channels: number; rate: number; blockAlign: number; bits: number; spb: number } | null = null;
  let factSamples = -1;
  let stick: DecodedWav['stick'];
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = ascii(bytes, o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      fmt = { tag: v.getUint16(body, true), channels: v.getUint16(body + 2, true), rate: v.getUint32(body + 4, true),
              blockAlign: v.getUint16(body + 12, true), bits: v.getUint16(body + 14, true),
              spb: size >= 20 ? v.getUint16(body + 18, true) : 0 };
    } else if (id === 'fact' && size >= 4) {
      factSamples = v.getUint32(body, true);
    } else if (id === 'bbly' && size >= 12) {
      stick = { flags: v.getUint32(body, true), startEpochMs: v.getUint32(body + 4, true) + v.getUint32(body + 8, true) * 2 ** 32 };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before fmt chunk');
      const end = Math.min(bytes.length, body + size);
      const data = bytes.subarray(body, end);
      if (fmt.tag === 1 && fmt.bits === 16) {
        const n = Math.floor(data.length / 2 / fmt.channels);
        const samples = new Int16Array(n);
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let i = 0; i < n; i++) samples[i] = dv.getInt16(i * 2 * fmt.channels, true); // first channel
        return { sampleRate: fmt.rate, channels: fmt.channels, samples, ...(stick ? { stick } : {}) };
      }
      if (fmt.tag === 0x11 && fmt.channels === 1) {
        const spb = fmt.spb || samplesPerBlock(fmt.blockAlign);
        const blocks = Math.floor(data.length / fmt.blockAlign);
        const total = factSamples >= 0 ? factSamples : blocks * spb;
        const samples = new Int16Array(total);
        let n = 0;
        for (let b = 0; b < blocks && n < total; b++) {
          n += decodeImaBlock(data.subarray(b * fmt.blockAlign, (b + 1) * fmt.blockAlign), samples, n, Math.min(spb, total - n));
        }
        return { sampleRate: fmt.rate, channels: 1, samples: samples.subarray(0, n), ...(stick ? { stick } : {}) };
      }
      throw new Error(`unsupported WAV format ${fmt.tag} (${fmt.channels} ch, ${fmt.bits} bit)`);
    }
    o = body + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}
