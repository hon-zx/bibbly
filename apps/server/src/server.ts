import { createServer as createHttp, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerMsg, Translator } from '@bibbly/core';
import { WebSocketServer, type WebSocket } from 'ws';
import { RoomHub, type Conn } from './hub.js';
import { listenerPage } from './listener-page.js';
import { OAuthBroker, type BrokerOptions } from './oauth-broker.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  translator: Translator | null;
  /** Connected-app sign-in broker (see oauth-broker.ts). Off when omitted. */
  oauth?: BrokerOptions | null;
}

export interface RunningServer { port: number; hub: RoomHub; broker: OAuthBroker | null; close(): Promise<void> }

export async function startServer(o: ServerOptions): Promise<RunningServer> {
  const hub = new RoomHub({ translator: o.translator });
  const broker = o.oauth ? new OAuthBroker(o.oauth) : null;
  const http = createHttp((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
                              'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:" });
      res.end(body);
    };
    if (url.pathname.startsWith('/oauth/')) {
      if (broker) { void broker.handle(req, res, url); return; }
      return send(404, 'application/json', JSON.stringify({ code: 'not_configured', message: 'Connected apps are not set up on this server.' }));
    }
    if (url.pathname === '/healthz') return send(200, 'application/json', JSON.stringify({ ok: true, rooms: hub.roomCount, translation: !!o.translator, connectors: broker?.configured() ?? [] }));
    const join = /^\/join\/([a-z0-9]{4,12})$/.exec(url.pathname);
    if (join) return send(200, 'text/html; charset=utf-8', listenerPage(join[1]!, !!o.translator));
    if (url.pathname === '/') return send(200, 'text/plain; charset=utf-8', 'Bibbly rooms server. Open /join/<room-code> to follow live captions.');
    return send(404, 'text/plain; charset=utf-8', 'Not found');
  });

  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 32 * 1024 });
  const alive = new WeakMap<WebSocket, boolean>();
  wss.on('connection', ws => {
    const conn: Conn = {
      send: (m: ServerMsg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); },
      close: (code, reason) => ws.close(code, reason),
    };
    alive.set(ws, true);
    hub.connect(conn);
    ws.on('pong', () => alive.set(ws, true));
    ws.on('message', (data, isBinary) => { if (!isBinary) hub.receive(conn, data.toString()); });
    ws.on('close', () => hub.disconnect(conn));
    ws.on('error', () => ws.terminate());
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) { ws.terminate(); continue; }
      alive.set(ws, false);
      ws.ping();
    }
    hub.sweep();
    broker?.sweep();
  }, 30_000);

  await new Promise<void>(res => http.listen(o.port ?? 8787, o.host ?? '0.0.0.0', res));
  const port = (http.address() as AddressInfo).port;
  if (broker && !broker.publicUrl) {
    const host = !o.host || o.host === '0.0.0.0' || o.host === '::' ? 'localhost' : o.host;
    broker.publicUrl = `http://${host}:${port}`;
  }
  return {
    port, hub, broker,
    close: () => new Promise<void>(res => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => http.close(() => res()));
    }),
  };
}
