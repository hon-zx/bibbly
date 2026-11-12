/** Speech engines get 16 kHz mono 16-bit PCM in 20 ms frames. */
export const SPEECH_RATE = 16_000;
export const FRAME_SAMPLES = 320;

export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

export function int16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i]! / 0x8000;
  return out;
}

/** Root-mean-square level of a frame, 0..1. */
export function rms(frame: Int16Array): number {
  if (!frame.length) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) { const v = frame[i]! / 0x8000; sum += v * v; }
  return Math.sqrt(sum / frame.length);
}

/** Level in dBFS (silence is -100). */
export const dbfs = (frame: Int16Array): number => { const r = rms(frame); return r > 0 ? 20 * Math.log10(r) : -100; };

/**
 * Streaming resampler for capture paths (48 kHz or 44.1 kHz down to 16 kHz).
 * A 2-pole low-pass at 0.45 × the output Nyquist removes most aliasing before
 * linear interpolation, which is enough for speech recognition.
 */
export class Resampler {
  private readonly step: number;
  private pos = 0;
  private prev = 0;
  private lp1 = 0;
  private lp2 = 0;
  private readonly alpha: number;

  constructor(readonly inRate: number, readonly outRate: number = SPEECH_RATE) {
    if (inRate <= 0 || outRate <= 0) throw new RangeError('sample rates must be positive');
    this.step = inRate / outRate;
    const cutoff = Math.min(0.45 * outRate, 0.45 * inRate);
    const rc = 1 / (2 * Math.PI * cutoff);
    const dt = 1 / inRate;
    this.alpha = dt / (rc + dt);
  }

  /** Accepts float samples (-1..1) and returns resampled 16-bit samples. */
  process(input: Float32Array): Int16Array {
    if (this.inRate === this.outRate) return floatToInt16(input);
    const out: number[] = [];
    for (let i = 0; i < input.length; i++) {
      this.lp1 += this.alpha * (input[i]! - this.lp1);
      this.lp2 += this.alpha * (this.lp1 - this.lp2);
      const cur = this.lp2;
      while (this.pos < 1) {
        out.push(this.prev + (cur - this.prev) * this.pos);
        this.pos += this.step;
      }
      this.pos -= 1;
      this.prev = cur;
    }
    return floatToInt16(Float32Array.from(out));
  }
}

/** Collects arbitrary-length sample runs into fixed-size frames. */
export class FrameChunker {
  private buf: Int16Array;
  private fill = 0;

  constructor(private readonly size: number = FRAME_SAMPLES) {
    this.buf = new Int16Array(size);
  }

  push(samples: Int16Array, onFrame: (frame: Int16Array) => void): void {
    let i = 0;
    while (i < samples.length) {
      const n = Math.min(this.size - this.fill, samples.length - i);
      this.buf.set(samples.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === this.size) {
        onFrame(this.buf.slice());
        this.fill = 0;
      }
    }
  }
}

export function concatInt16(chunks: readonly Int16Array[]): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Int16Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
