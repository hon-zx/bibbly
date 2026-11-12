import { concatInt16, dbfs, FRAME_SAMPLES, SPEECH_RATE } from './pcm.js';

export interface VadOptions {
  /** dB above the tracked noise floor that counts as speech. */
  thresholdDb?: number;
  /** Absolute floor in dBFS below which nothing counts as speech. */
  minDbfs?: number;
  /** Frames of speech needed to open a segment (20 ms each). */
  startFrames?: number;
  /** Frames of silence that close a segment. */
  hangoverFrames?: number;
  /** Frames kept from before the segment opened. */
  prerollFrames?: number;
  /** Longest segment before it is cut, in seconds. */
  maxSegmentSec?: number;
  sampleRate?: number;
}

export interface SpeechSegment {
  /** Start and end in seconds from the first frame pushed. */
  start: number;
  end: number;
  samples: Int16Array;
}

/**
 * Energy-based voice activity detector with an adaptive noise floor.
 * Splits a stream of 20 ms frames into speech segments for engines that
 * transcribe one utterance at a time (Whisper-style), and gives the UI a
 * reliable "someone is talking" signal.
 */
export class EnergyVad {
  private readonly o: Required<VadOptions>;
  private noise = -60;
  private frameIndex = 0;
  private speaking = false;
  private run = 0;
  private silence = 0;
  private preroll: Int16Array[] = [];
  private seg: Int16Array[] = [];
  private segStartFrame = 0;

  constructor(opts: VadOptions = {}) {
    this.o = {
      thresholdDb: 10, minDbfs: -48, startFrames: 3, hangoverFrames: 30, prerollFrames: 10,
      maxSegmentSec: 15, sampleRate: SPEECH_RATE, ...opts,
    };
  }

  get isSpeaking(): boolean { return this.speaking; }
  get noiseFloorDb(): number { return this.noise; }

  /** Feeds one frame; returns a finished segment when one closes. */
  push(frame: Int16Array): SpeechSegment | null {
    const level = dbfs(frame);
    const loud = level > this.noise + this.o.thresholdDb && level > this.o.minDbfs;
    // Track the noise floor: fast down, slow up, frozen while speaking.
    if (!this.speaking) this.noise = level < this.noise ? this.noise * 0.7 + level * 0.3 : this.noise * 0.995 + level * 0.005;
    const idx = this.frameIndex++;
    let done: SpeechSegment | null = null;

    if (!this.speaking) {
      this.preroll.push(frame);
      if (this.preroll.length > this.o.prerollFrames + this.o.startFrames) this.preroll.shift();
      this.run = loud ? this.run + 1 : 0;
      if (this.run >= this.o.startFrames) {
        this.speaking = true;
        this.silence = 0;
        this.seg = [...this.preroll];
        this.segStartFrame = idx - this.preroll.length + 1;
        this.preroll = [];
      }
    } else {
      this.seg.push(frame);
      this.silence = loud ? 0 : this.silence + 1;
      const tooLong = this.seg.length * frame.length >= this.o.maxSegmentSec * this.o.sampleRate;
      if (this.silence >= this.o.hangoverFrames || tooLong) done = this.close();
    }
    return done;
  }

  /** Closes any open segment (call when the stream ends). */
  flush(): SpeechSegment | null {
    return this.speaking ? this.close() : null;
  }

  private close(): SpeechSegment {
    // Trim the trailing silence, keeping 200 ms of it.
    const keep = Math.max(0, this.seg.length - Math.max(0, this.silence - 10));
    const frames = this.seg.slice(0, keep);
    const samples = concatInt16(frames);
    const frameLen = frames[0]?.length ?? FRAME_SAMPLES;
    const start = (this.segStartFrame * frameLen) / this.o.sampleRate;
    const seg: SpeechSegment = { start, end: start + samples.length / this.o.sampleRate, samples };
    this.speaking = false;
    this.run = 0;
    this.silence = 0;
    this.seg = [];
    return seg;
  }
}
