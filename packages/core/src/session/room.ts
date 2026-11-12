import { LANGUAGES } from '../lang.js';
import type { LangCode } from '../types.js';
import { cleanText, Emitter } from '../util.js';

/**
 * Bibbly rooms: a host shares live captions; listeners join with a link or QR
 * code and pick their own language. The server translates each line once per
 * language present in the room and sends each listener only their language.
 */
export const ROOM_PROTOCOL = 1;
const KNOWN = new Set(LANGUAGES.map(l => l.code));
export const isLang = (v: unknown): v is LangCode => typeof v === 'string' && KNOWN.has(v);

export interface WireLine { id: string; t: number; speaker: string; text: string; lang: LangCode; langs?: LangCode[]; confidence?: number }
export interface Member { id: string; name: string; lang: LangCode; role: 'host' | 'listener' }

export type ClientMsg =
  | { t: 'hello'; v: number; room: string; role: 'host' | 'listener'; name: string; lang: LangCode; key?: string }
  | { t: 'lang'; lang: LangCode }
  | { t: 'caption'; line: WireLine }
  | { t: 'partial'; speaker: string; text: string; lang?: LangCode }
  | { t: 'end' };

export type ServerMsg =
  | { t: 'welcome'; room: string; you: string; role: 'host' | 'listener'; members: Member[]; history: WireLine[]; translations: Record<string, string> }
  | { t: 'members'; members: Member[] }
  | { t: 'caption'; line: WireLine }
  | { t: 'translation'; id: string; lang: LangCode; text: string }
  | { t: 'partial'; speaker: string; text: string; lang?: LangCode }
  | { t: 'ended' }
  | { t: 'error'; code: string; message: string };

export const ROOM_CODE = /^[a-z0-9]{4,12}$/;
export const newRoomCode = (): string => Array.from({ length: 6 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join('');

function wireLine(v: unknown): WireLine | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const text = typeof o.text === 'string' ? o.text.slice(0, 2000) : '';
  if (typeof o.id !== 'string' || !o.id || o.id.length > 64 || !text.trim() || !isLang(o.lang)) return null;
  const langs = Array.isArray(o.langs) ? o.langs.filter(isLang).slice(0, 4) : undefined;
  return {
    id: o.id, t: typeof o.t === 'number' && Number.isFinite(o.t) ? Math.max(0, o.t) : 0, speaker: cleanText(o.speaker, 48) || 'Speaker',
    text, lang: o.lang, ...(langs && langs.length > 1 ? { langs } : {}),
    ...(typeof o.confidence === 'number' ? { confidence: Math.min(1, Math.max(0, o.confidence)) } : {}),
  };
}

/** Validates an untrusted client message (server side). */
export function parseClientMsg(raw: string): ClientMsg | null {
  if (raw.length > 16_384) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  switch (o.t) {
    case 'hello':
      if (typeof o.room !== 'string' || !ROOM_CODE.test(o.room) || (o.role !== 'host' && o.role !== 'listener') || !isLang(o.lang)) return null;
      return { t: 'hello', v: Number(o.v) || 0, room: o.room, role: o.role, name: cleanText(o.name, 40) || 'Guest', lang: o.lang,
               ...(typeof o.key === 'string' ? { key: o.key.slice(0, 128) } : {}) };
    case 'lang': return isLang(o.lang) ? { t: 'lang', lang: o.lang } : null;
    case 'caption': { const line = wireLine(o.line); return line ? { t: 'caption', line } : null; }
    case 'partial':
      return { t: 'partial', speaker: cleanText(o.speaker, 48), text: typeof o.text === 'string' ? o.text.slice(0, 600) : '', ...(isLang(o.lang) ? { lang: o.lang } : {}) };
    case 'end': return { t: 'end' };
    default: return null;
  }
}

/** Validates an untrusted server message (client side). */
export function parseServerMsg(raw: string): ServerMsg | null {
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  const members = (v: unknown): Member[] => (Array.isArray(v) ? v : []).flatMap(m => {
    const x = m as Record<string, unknown>;
    return typeof x?.id === 'string' && isLang(x.lang) ? [{ id: x.id, name: cleanText(x.name, 40) || 'Guest', lang: x.lang, role: x.role === 'host' ? 'host' as const : 'listener' as const }] : [];
  });
  switch (o?.t) {
    case 'welcome': return { t: 'welcome', room: String(o.room), you: String(o.you), role: o.role === 'host' ? 'host' : 'listener', members: members(o.members),
                             history: (Array.isArray(o.history) ? o.history : []).map(wireLine).filter((l): l is WireLine => !!l),
                             translations: typeof o.translations === 'object' && o.translations ? Object.fromEntries(Object.entries(o.translations as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {} };
    case 'members': return { t: 'members', members: members(o.members) };
    case 'caption': { const line = wireLine(o.line); return line ? { t: 'caption', line } : null; }
    case 'translation': return typeof o.id === 'string' && isLang(o.lang) && typeof o.text === 'string' ? { t: 'translation', id: o.id, lang: o.lang, text: o.text.slice(0, 4000) } : null;
    case 'partial': return { t: 'partial', speaker: cleanText(o.speaker, 48), text: typeof o.text === 'string' ? o.text.slice(0, 600) : '', ...(isLang(o.lang) ? { lang: o.lang } : {}) };
    case 'ended': return { t: 'ended' };
    case 'error': return { t: 'error', code: cleanText(o.code, 40), message: cleanText(o.message, 300) };
    default: return null;
  }
}

export type RoomClientEvents = {
  open: void;
  close: { willRetry: boolean };
  message: ServerMsg;
};

type WsLike = { send(d: string): void; close(): void; readyState: number; onopen: ((e: unknown) => void) | null; onclose: ((e: unknown) => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onerror: ((e: unknown) => void) | null };

/** Room connection with automatic reconnects; works with the WebSocket global in browsers, React Native and Node 22. */
export class RoomClient extends Emitter<RoomClientEvents> {
  private ws: WsLike | null = null;
  private stopped = false;
  private retries = 0;
  private hello: Extract<ClientMsg, { t: 'hello' }>;

  constructor(private readonly url: string, hello: Omit<Extract<ClientMsg, { t: 'hello' }>, 't' | 'v'>,
              private readonly WsImpl: new (url: string) => WsLike = (globalThis as unknown as { WebSocket: new (url: string) => WsLike }).WebSocket) {
    super();
    this.hello = { t: 'hello', v: ROOM_PROTOCOL, ...hello };
  }

  connect(): void {
    this.stopped = false;
    const ws = new this.WsImpl(this.url);
    this.ws = ws;
    ws.onopen = () => { this.retries = 0; ws.send(JSON.stringify(this.hello)); this.emit('open', undefined); };
    ws.onmessage = e => { const m = typeof e.data === 'string' ? parseServerMsg(e.data) : null; if (m) this.emit('message', m); };
    ws.onclose = () => {
      const willRetry = !this.stopped;
      this.emit('close', { willRetry });
      if (willRetry) setTimeout(() => { if (!this.stopped) this.connect(); }, Math.min(10_000, 1000 * 2 ** this.retries++));
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private send(m: ClientMsg) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
  setLang(lang: LangCode) { this.hello = { ...this.hello, lang }; this.send({ t: 'lang', lang }); }
  caption(line: WireLine) { this.send({ t: 'caption', line }); }
  partial(speaker: string, text: string, lang?: LangCode) { this.send({ t: 'partial', speaker, text, ...(lang ? { lang } : {}) }); }
  end() { this.send({ t: 'end' }); }
  close() { this.stopped = true; this.ws?.close(); this.ws = null; }
}
