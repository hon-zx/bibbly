/** Base64 helpers for bytes from native modules and Bluetooth (no Buffer in React Native). */
const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Uint8Array(128);
for (let i = 0; i < ABC.length; i++) LOOKUP[ABC.charCodeAt(i)] = i;

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = LOOKUP[clean.charCodeAt(i)]!, b = LOOKUP[clean.charCodeAt(i + 1)]!;
    const c = LOOKUP[clean.charCodeAt(i + 2)] ?? 0, d = LOOKUP[clean.charCodeAt(i + 3)] ?? 0;
    out[o++] = (a << 2) | (b >> 4);
    if (i + 2 < clean.length) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (i + 3 < clean.length) out[o++] = ((c & 3) << 6) | d;
  }
  return out.subarray(0, o);
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    s += ABC[a >> 2]! + ABC[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    s += b === undefined ? '=' : ABC[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    s += c === undefined ? '=' : ABC[c & 63]!;
  }
  return s;
}

/** Little-endian 16-bit samples from base64. */
export function pcmFromBase64(s: string): Int16Array {
  const bytes = fromBase64(s);
  const out = new Int16Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = ((bytes[2 * i]! | (bytes[2 * i + 1]! << 8)) << 16) >> 16;
  return out;
}
