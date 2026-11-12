import { FrameChunker, FRAME_SAMPLES, Resampler, rms, type Channel } from '@bibbly/core';

/** Captures one audio source and delivers 16 kHz mono PCM frames. */
export class AudioCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;

  constructor(readonly channel: Channel, private readonly onFrame: (pcm: Int16Array) => void, private readonly onLevel?: (level: number) => void) {}

  /** A microphone, including the Bibbly Stick, which appears as a standard USB microphone. */
  async startMic(deviceId?: string): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    await this.wire();
  }

  /** The computer's own audio output: everyone else on Zoom, Teams, Meet or Lark. */
  async startSystem(): Promise<void> {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    s.getVideoTracks().forEach(t => t.stop());
    const audio = s.getAudioTracks();
    if (!audio.length) throw new Error('This computer did not share its audio. On macOS 12 or earlier, route meeting audio through a virtual audio device and pick it as a microphone.');
    this.stream = new MediaStream(audio);
    await this.wire();
  }

  private async wire(): Promise<void> {
    const ctx = new AudioContext();
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(new URL('./capture-worklet.js', document.baseURI).href);
    const src = ctx.createMediaStreamSource(this.stream!);
    const node = new AudioWorkletNode(ctx, 'bibbly-tap');
    this.node = node;
    const resampler = new Resampler(ctx.sampleRate, 16_000);
    const chunker = new FrameChunker(FRAME_SAMPLES * 5);
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const pcm = resampler.process(e.data);
      chunker.push(pcm, f => this.onFrame(f));
      this.onLevel?.(rms(pcm));
    };
    // Keep the graph pulled without making any sound.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node).connect(mute).connect(ctx.destination);
  }

  async stop(): Promise<void> {
    this.stream?.getTracks().forEach(t => t.stop());
    this.node?.disconnect();
    await this.ctx?.close().catch(() => undefined);
    this.stream = null; this.node = null; this.ctx = null;
  }
}

/** Finds the Bibbly Stick among the computer's microphones. */
export async function findStickMic(): Promise<string | null> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.find(d => d.kind === 'audioinput' && /bibbly/i.test(d.label))?.deviceId ?? null;
}
