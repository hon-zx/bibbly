// Collects microphone or meeting audio into ~43 ms blocks (2048 samples) of mono float PCM
// and hands them to the page, which resamples to 16 kHz for the speech engine.
class BibblyTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const a = input[0];
      const b = input[1];
      for (let i = 0; i < a.length; i++) {
        this.buf[this.n++] = b ? (a[i] + b[i]) * 0.5 : a[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('bibbly-tap', BibblyTap);
