import {
  LiveSession, parseClientMsg, uid, type ClientMsg, type LangCode, type Member, type ServerMsg, type Translator, type WireLine,
} from '@bibbly/core';

/** One connected socket, as the hub sees it. */
export interface Conn {
  send(msg: ServerMsg): void;
  close(code?: number, reason?: string): void;
}

interface Client { id: string; conn: Conn; room: Room | null; name: string; lang: LangCode; role: 'host' | 'listener'; lastCaption: number[] }
interface Room { code: string; key: string | null; session: LiveSession; members: Map<string, Client>; wire: Map<string, WireLine>; lastActive: number; ended: boolean }

export interface HubOptions {
  translator: Translator | null;
  /** Lines kept for people who join late. */
  historyLimit?: number;
  /** Captions a host may send per second. */
  captionsPerSecond?: number;
  now?: () => number;
}

/**
 * Rooms for shared live captions. Hosts publish settled lines; each listener
 * picks a language; every line is translated once per language present.
 */
export class RoomHub {
  private readonly rooms = new Map<string, Room>();
  private readonly clients = new Map<Conn, Client>();
  private readonly now: () => number;

  constructor(private readonly o: HubOptions) { this.now = o.now ?? Date.now; }

  get roomCount(): number { return this.rooms.size; }

  connect(conn: Conn): void {
    this.clients.set(conn, { id: uid('c_'), conn, room: null, name: 'Guest', lang: 'en', role: 'listener', lastCaption: [] });
  }

  disconnect(conn: Conn): void {
    const c = this.clients.get(conn);
    this.clients.delete(conn);
    if (!c?.room) return;
    const room = c.room;
    room.members.delete(c.id);
    room.session.removeTarget(c.lang);
    this.broadcastMembers(room);
  }

  receive(conn: Conn, raw: string): void {
    const c = this.clients.get(conn);
    if (!c) return;
    const msg = parseClientMsg(raw);
    if (!msg) { conn.send({ t: 'error', code: 'bad_message', message: 'Bibbly could not read that message.' }); return; }
    if (msg.t === 'hello') { this.hello(c, msg); return; }
    const room = c.room;
    if (!room) { conn.send({ t: 'error', code: 'not_joined', message: 'Join a room first.' }); return; }
    room.lastActive = this.now();
    switch (msg.t) {
      case 'lang':
        if (msg.lang !== c.lang) {
          room.session.addTarget(msg.lang);
          room.session.removeTarget(c.lang);
          c.lang = msg.lang;
          this.sendTranslations(c, room);
          this.broadcastMembers(room);
        }
        break;
      case 'caption': this.caption(c, room, msg.line); break;
      case 'partial':
        if (c.role === 'host') this.fanout(room, { t: 'partial', speaker: msg.speaker, text: msg.text, ...(msg.lang ? { lang: msg.lang } : {}) }, c.id);
        break;
      case 'end':
        if (c.role === 'host') { room.ended = true; this.fanout(room, { t: 'ended' }); }
        break;
    }
  }

  private hello(c: Client, msg: Extract<ClientMsg, { t: 'hello' }>): void {
    if (c.room) { c.conn.send({ t: 'error', code: 'already_joined', message: 'Already in a room.' }); return; }
    let room = this.rooms.get(msg.room);
    if (msg.role === 'host') {
      if (!room) room = this.create(msg.room, msg.key ?? null, msg.lang);
      else if (room.key && room.key !== msg.key) { c.conn.send({ t: 'error', code: 'not_host', message: 'This room already has a host.' }); c.conn.close(4003, 'not host'); return; }
      room.ended = false;
    } else if (!room) {
      c.conn.send({ t: 'error', code: 'no_room', message: 'That room has not started yet. Check the code, or wait for the host.' });
      c.conn.close(4004, 'no room');
      return;
    }
    c.room = room; c.name = msg.name; c.lang = msg.lang; c.role = msg.role;
    room.members.set(c.id, c);
    room.session.addTarget(c.lang);
    room.lastActive = this.now();
    const history = [...room.wire.values()];
    c.conn.send({ t: 'welcome', room: room.code, you: c.id, role: c.role, members: this.memberList(room), history, translations: this.translationsFor(room, c.lang) });
    this.broadcastMembers(room);
  }

  private create(code: string, key: string | null, hostLang: LangCode): Room {
    const session = new LiveSession({ id: code, title: `Room ${code}`, me: { id: 'host', name: 'Host', self: true }, myLang: hostLang, candidateLanguages: [], autoClarityEvery: 0 },
                                    { translator: this.o.translator, clarity: null });
    const room: Room = { code, key, session, members: new Map(), wire: new Map(), lastActive: this.now(), ended: false };
    session.on('translation', ({ lineId, lang }) => {
      const text = session.lines.find(l => l.id === lineId)?.tr[lang];
      if (!text) return;
      for (const m of room.members.values()) if (m.lang === lang) m.conn.send({ t: 'translation', id: lineId, lang, text });
    });
    this.rooms.set(code, room);
    return room;
  }

  private caption(c: Client, room: Room, line: WireLine): void {
    if (c.role !== 'host') { c.conn.send({ t: 'error', code: 'not_host', message: 'Only the host can share captions.' }); return; }
    const now = this.now();
    c.lastCaption = c.lastCaption.filter(t => now - t < 1000);
    if (c.lastCaption.length >= (this.o.captionsPerSecond ?? 10)) return;
    c.lastCaption.push(now);
    if (room.wire.has(line.id)) return;
    room.wire.set(line.id, line);
    const limit = this.o.historyLimit ?? 300;
    if (room.wire.size > limit) room.wire.delete(room.wire.keys().next().value!);
    this.fanout(room, { t: 'caption', line }, c.id);
    room.session.addLine({ id: line.id, t: line.t, speaker: { id: line.speaker, name: line.speaker }, channel: 'remote', text: line.text, lang: line.lang,
                           ...(line.langs ? { langs: line.langs } : {}), ...(line.confidence != null ? { confidence: line.confidence } : {}) });
  }

  private translationsFor(room: Room, lang: LangCode): Record<string, string> {
    const out: Record<string, string> = {};
    for (const l of room.session.lines) { const t = l.tr[lang]; if (t && room.wire.has(l.id)) out[l.id] = t; }
    return out;
  }

  private sendTranslations(c: Client, room: Room): void {
    for (const [id, text] of Object.entries(this.translationsFor(room, c.lang))) c.conn.send({ t: 'translation', id, lang: c.lang, text });
  }

  private memberList(room: Room): Member[] {
    return [...room.members.values()].map(m => ({ id: m.id, name: m.name, lang: m.lang, role: m.role }));
  }

  private broadcastMembers(room: Room): void { this.fanout(room, { t: 'members', members: this.memberList(room) }); }

  private fanout(room: Room, msg: ServerMsg, exceptId?: string): void {
    for (const m of room.members.values()) if (m.id !== exceptId) m.conn.send(msg);
  }

  /** Drops rooms nobody has used for `idleMs`. */
  sweep(idleMs = 2 * 60 * 60 * 1000): void {
    const now = this.now();
    for (const [code, room] of this.rooms) {
      if (room.members.size === 0 && now - room.lastActive > idleMs) { room.session.dispose(); this.rooms.delete(code); }
    }
  }
}
