/**
 * IMA ADPCM (as used in WAV format 0x0011, mono). The Bibbly Stick records
 * offline audio with this codec: 4:1 compression, trivial CPU cost, and
 * decoders everywhere. firmware/bibbly-stick/components/stick_core/adpcm.c
 * is the matching encoder; both sides are tested against each other.
 */
export const IMA_STEP_TABLE: readonly number[] = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060,
  1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484,
  7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
export const IMA_INDEX_TABLE: readonly number[] = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

export interface ImaState { predictor: number; index: number; }

const clamp16 = (v: number) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

export function imaDecodeNibble(nibble: number, st: ImaState): number {
  const step = IMA_STEP_TABLE[st.index]!;
  let diff = step >> 3;
  if (nibble & 4) diff += step;
  if (nibble & 2) diff += step >> 1;
  if (nibble & 1) diff += step >> 2;
  st.predictor = clamp16(nibble & 8 ? st.predictor - diff : st.predictor + diff);
  st.index = Math.min(88, Math.max(0, st.index + IMA_INDEX_TABLE[nibble]!));
  return st.predictor;
}

export function imaEncodeSample(sample: number, st: ImaState): number {
  const step = IMA_STEP_TABLE[st.index]!;
  let diff = sample - st.predictor;
  let nibble = 0;
  if (diff < 0) { nibble = 8; diff = -diff; }
  let delta = step >> 3;
  if (diff >= step) { nibble |= 4; diff -= step; delta += step; }
  if (diff >= step >> 1) { nibble |= 2; diff -= step >> 1; delta += step >> 1; }
  if (diff >= step >> 2) { nibble |= 1; delta += step >> 2; }
  st.predictor = clamp16(nibble & 8 ? st.predictor - delta : st.predictor + delta);
  st.index = Math.min(88, Math.max(0, st.index + IMA_INDEX_TABLE[nibble]!));
  return nibble;
}

export const samplesPerBlock = (blockAlign: number): number => (blockAlign - 4) * 2 + 1;

/** Decodes one mono IMA ADPCM block (4-byte header + packed nibbles, low nibble first). */
export function decodeImaBlock(block: Uint8Array, out: Int16Array, outOffset: number, maxSamples: number): number {
  if (block.length < 4) return 0;
  const st: ImaState = { predictor: ((block[0]! | (block[1]! << 8)) << 16) >> 16, index: Math.min(88, block[2]!) };
  let n = 0;
  out[outOffset + n++] = st.predictor;
  for (let i = 4; i < block.length && n < maxSamples; i++) {
    const b = block[i]!;
    out[outOffset + n++] = imaDecodeNibble(b & 0x0f, st);
    if (n < maxSamples) out[outOffset + n++] = imaDecodeNibble(b >> 4, st);
  }
  return n;
}

/** Encodes mono samples into IMA ADPCM blocks; the last block is zero-padded. */
export function encodeIma(samples: Int16Array, blockAlign = 512): Uint8Array {
  const spb = samplesPerBlock(blockAlign);
  const blocks = Math.ceil(samples.length / spb) || 1;
  const out = new Uint8Array(blocks * blockAlign);
  const st: ImaState = { predictor: 0, index: 0 };
  for (let b = 0; b < blocks; b++) {
    const base = b * spb;
    const o = b * blockAlign;
    const first = samples[base] ?? 0;
    st.predictor = first;
    out[o] = first & 0xff;
    out[o + 1] = (first >> 8) & 0xff;
    out[o + 2] = st.index;
    out[o + 3] = 0;
    for (let i = 1; i < spb; i += 2) {
      const lo = imaEncodeSample(samples[base + i] ?? 0, st);
      const hi = imaEncodeSample(samples[base + i + 1] ?? 0, st);
      out[o + 4 + ((i - 1) >> 1)] = lo | (hi << 4);
    }
  }
  return out;
}
