import { describe, expect, it } from 'vitest';
import { decodeImaBlock, encodeIma, samplesPerBlock } from '../src/audio/adpcm.js';
import { FrameChunker, Resampler, rms } from '../src/audio/pcm.js';
import { EnergyVad, type SpeechSegment } from '../src/audio/vad.js';
import { decodeWav, encodeWavIma, encodeWavPcm16 } from '../src/audio/wav.js';
import { bursts, sine, toInt16 } from './helpers.js';

const snrDb = (ref: Int16Array, test: Int16Array) => {
  let s = 0, n = 0;
  for (let i = 0; i < ref.length; i++) { s += ref[i]! ** 2; n += (ref[i]! - (test[i] ?? 0)) ** 2; }
  return 10 * Math.log10(s / Math.max(1, n));
};

describe('resampler', () => {
  it('turns 48 kHz into 16 kHz and keeps the tone', () => {
    const r = new Resampler(48_000, 16_000);
    const out = r.process(sine(440, 48_000, 1));
    expect(Math.abs(out.length - 16_000)).toBeLessThanOrEqual(2);
    let crossings = 0;
    for (let i = 1; i < out.length; i++) if (out[i - 1]! < 0 && out[i]! >= 0) crossings++;
    expect(crossings).toBeGreaterThan(430);
    expect(crossings).toBeLessThan(450);
  });
  it('attenuates content above the new Nyquist', () => {
    const r = new Resampler(48_000, 16_000);
    const out = r.process(sine(15_000, 48_000, 0.5));
    expect(rms(out.subarray(1000))).toBeLessThan(0.08);
  });
});

describe('voice activity detection', () => {
  it('finds each burst of speech', () => {
    const pcm = bursts(16_000, [[1, 1.2], [0.9, 0.8], [1.2, 2]]);
    const vad = new EnergyVad();
    const chunker = new FrameChunker(320);
    const segs: SpeechSegment[] = [];
    chunker.push(pcm, f => { const s = vad.push(f); if (s) segs.push(s); });
    const last = vad.flush();
    if (last) segs.push(last);
    expect(segs.length).toBe(3);
    expect(segs[0]!.start).toBeGreaterThan(0.6);
    expect(segs[0]!.start).toBeLessThan(1.05);
    expect(segs[2]!.end - segs[2]!.start).toBeGreaterThan(1.8);
  });
});

describe('IMA ADPCM + WAV', () => {
  const voice = toInt16(Float32Array.from(sine(220, 16_000, 2), (v, i) => v * 0.8 + 0.15 * Math.sin((2 * Math.PI * 1250 * i) / 16_000)));
  it('round-trips with good quality', () => {
    const enc = encodeIma(voice, 512);
    const spb = samplesPerBlock(512);
    expect(enc.length).toBe(Math.ceil(voice.length / spb) * 512);
    const out = new Int16Array(voice.length);
    let n = 0;
    for (let b = 0; n < voice.length; b++) n += decodeImaBlock(enc.subarray(b * 512, (b + 1) * 512), out, n, Math.min(spb, voice.length - n));
    expect(snrDb(voice, out)).toBeGreaterThan(20);
  });
  it('parses PCM and Stick (IMA + bbly) WAV files', () => {
    const pcm = decodeWav(encodeWavPcm16(voice, 16_000));
    expect(pcm.sampleRate).toBe(16_000);
    expect(Array.from(pcm.samples.subarray(0, 50))).toEqual(Array.from(voice.subarray(0, 50)));
    const start = Date.UTC(2026, 10, 12, 4, 40);
    const ima = decodeWav(encodeWavIma(voice, 16_000, start));
    expect(ima.samples.length).toBe(voice.length);
    expect(ima.stick?.startEpochMs).toBe(start);
    expect(snrDb(voice, ima.samples)).toBeGreaterThan(20);
  });
  it('rejects non-WAV data', () => {
    expect(() => decodeWav(new Uint8Array(20))).toThrow(/not a WAV/);
  });
});
