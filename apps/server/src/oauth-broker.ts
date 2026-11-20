/**
 * OAuth broker for connected apps. The phone app (every provider) and the
 * desktop app (Slack, Notion, Lark) connect accounts through this server so
 * client secrets never ship inside an app. The server runs the redirect,
 * exchanges the code with the client secret, and hands the tokens once to the
 * device that started the sign-in. Tokens stay in memory only until they are
 * collected or the sign-in expires, and are never logged.
 *
 *   GET  /oauth/providers                                     -> {providers: [{id, name, configured}]}
 *   POST /oauth/:provider/start      {appRedirect}            -> {sessionId, secret, authorizeUrl, expiresAt}
 *   GET  /oauth/:provider/callback   ?code&state | ?error     -> 302 appRedirect?session&code  (or &error)
 *   POST /oauth/session/:id/collect  X-Bibbly-Session, {code} -> {provider, tokens}
 *   POST /oauth/:provider/refresh    {refreshToken}           -> {tokens}
 *
 * Collecting needs the per-sign-in secret (only the starting device has it)
 * and the completion code (only the browser that finished signing in gets it,
 * through the app redirect). So a sign-in link forwarded to someone else is
 * useless to whoever sent it, and an app that intercepts bibbly:// can't
 * collect either. App redirects must be bibbly://… or a loopback address.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ConnectorError, Http, PROVIDERS, PROVIDER_IDS, buildAuthorizeUrl, defaultEndpoints, endpointsAt, exchangeCode, oauthApp, refreshTokens,
  type ClientConfig, type Endpoints, type OAuthApp, type ProviderId, type TokenSet,
} from '@bibbly/connectors';
import { pkcePair } from '@bibbly/connectors/node';

export interface BrokerOptions {
  /** Public address of this server. Redirect URIs are `${publicUrl}/oauth/<provider>/callback`. Defaults to the local address. */
  publicUrl?: string;
  /** Client registrations; a provider is offered when it has both an id and a secret. */
  clients: Partial<Record<ProviderId, ClientConfig>>;
  endpoints?: Endpoints;
  /** How long a sign-in may take (10 minutes). */
  ttlMs?: number;
  /** Sign-ins in progress at once. */
  maxSessions?: number;
  /** Requests per minute from one address. */
  rateLimit?: Partial<Record<'start' | 'collect' | 'refresh', number>>;
  /** Read the client address from X-Forwarded-For (behind a reverse proxy). */
  trustProxy?: boolean;
  now?: () => number;
  fetch?: typeof fetch;
}

interface Session {
  id: string;
  secretHash: Buffer;
  provider: ProviderId;
  state: string;
  verifier?: string;
  appRedirect: string;
  createdAt: number;
  status: 'pending' | 'done';
  tokens?: TokenSet;
  completionHash?: Buffer;
  failures: number;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const token = (bytes: number) => randomBytes(bytes).toString('base64url');
const sha = (s: string) => createHash('sha256').update(s).digest();
const matches = (hash: Buffer | undefined, value: string) => !!hash && !!value && timingSafeEqual(hash, sha(value));

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** bibbly://… (phone) or http://127.0.0.1:<port>/… (desktop); anything else is refused. */
export function allowedAppRedirect(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 512) return null;
  let u: URL;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol === 'bibbly:') return v;
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname) && u.port) return v;
  return null;
}

const SECURITY_HEADERS = { 'cache-control': 'no-store', pragma: 'no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
/**
 * Browser builds of Bibbly call the API cross-origin. Every endpoint is
 * protected by per-sign-in secrets or tokens in the body, never by cookies,
 * so any origin may call it (without credentials).
 */
const CORS = { 'access-control-allow-origin': '*' };

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): true {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...CORS, ...headers });
  res.end(JSON.stringify(body));
  return true;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function sendPage(res: ServerResponse, status: number, title: string, body: string): true {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS, 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>
<body style="font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#EDF4F1;color:#12302C">
<div style="text-align:center;max-width:420px;padding:0 16px"><h1 style="font-size:22px">${esc(title)}</h1><p>${esc(body)}</p></div></body>`);
  return true;
}

function redirect(res: ServerResponse, base: string, params: Record<string, string>): true {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  res.writeHead(302, { location: u.toString(), ...SECURITY_HEADERS });
  res.end();
  return true;
}

async function readJson(req: IncomingMessage, limit = 8192): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'too_large', 'Request too large.');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'bad_json', 'Send a JSON body.');
  }
}

export class OAuthBroker {
  publicUrl: string;
  private readonly sessions = new Map<string, Session>();
  private readonly byState = new Map<string, string>();
  private readonly hits = new Map<string, { n: number; at: number }>();
  private readonly ep: Endpoints;
  private readonly http: Http;
  private readonly now: () => number;
  private readonly ttl: number;

  constructor(private readonly o: BrokerOptions) {
    this.publicUrl = (o.publicUrl ?? '').replace(/\/+$/, '');
    this.ep = o.endpoints ?? defaultEndpoints();
    this.http = new Http('oauth', o.fetch ? { fetch: o.fetch } : {});
    this.now = o.now ?? Date.now;
    this.ttl = o.ttlMs ?? 10 * 60_000;
  }

  /** Providers this server has a client id and secret for. */
  configured(): ProviderId[] {
    return PROVIDER_IDS.filter(p => !!this.o.clients[p]?.clientId && !!this.o.clients[p]?.clientSecret);
  }

  get pending(): number { return this.sessions.size; }

  redirectUri(p: ProviderId): string { return `${this.publicUrl}/oauth/${p}/callback`; }

  private app(p: ProviderId): OAuthApp { return oauthApp(p, this.o.clients[p]!, this.ep); }

  /** Handles /oauth/… requests. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      res.writeHead(204, { ...CORS, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, x-bibbly-session', 'access-control-max-age': '600' });
      res.end();
      return;
    }
    try {
      if (path === '/oauth/providers' && method === 'GET') {
        const ok = this.configured();
        sendJson(res, 200, { providers: PROVIDER_IDS.map(id => ({ id, name: PROVIDERS[id].name, configured: ok.includes(id), ...(PROVIDERS[id].beta ? { beta: true } : {}) })) });
        return;
      }
      const collect = /^\/oauth\/session\/([A-Za-z0-9_-]{16,64})\/collect$/.exec(path);
      if (collect && method === 'POST') { await this.collect(collect[1]!, req, res); return; }
      const m = /^\/oauth\/([a-z]+)\/(start|callback|refresh)$/.exec(path);
      if (m && (PROVIDER_IDS as string[]).includes(m[1]!)) {
        const provider = m[1] as ProviderId;
        if (m[2] === 'callback' && method === 'GET') { await this.callback(provider, url, res); return; }
        if (!this.configured().includes(provider)) throw new HttpError(404, 'not_configured', `This Bibbly server isn't set up to connect ${PROVIDERS[provider].name}.`);
        if (m[2] === 'start' && method === 'POST') { await this.start(provider, req, res); return; }
        if (m[2] === 'refresh' && method === 'POST') { await this.refresh(provider, req, res); return; }
      }
      throw new HttpError(404, 'not_found', 'Not found.');
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { code: err.code, message: err.message }, err.status === 429 ? { 'retry-after': '60' } : {});
        return;
      }
      console.error(`[oauth] ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`);
      sendJson(res, 500, { code: 'internal', message: 'Something went wrong on the Bibbly server.' });
    }
  }

  private limit(req: IncomingMessage, kind: 'start' | 'collect' | 'refresh') {
    const max = this.o.rateLimit?.[kind] ?? { start: 20, collect: 60, refresh: 120 }[kind];
    const fwd = this.o.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim() : '';
    const key = `${kind}:${fwd || req.socket.remoteAddress || '?'}`;
    const now = this.now();
    const h = this.hits.get(key);
    if (!h || now - h.at >= 60_000) { this.hits.set(key, { n: 1, at: now }); return; }
    if (++h.n > max) throw new HttpError(429, 'rate_limited', 'Too many requests. Try again in a minute.');
  }

  private live(id: string): Session | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (this.now() - s.createdAt > this.ttl) { this.drop(s); return null; }
    return s;
  }

  private drop(s: Session) {
    this.sessions.delete(s.id);
    this.byState.delete(s.state);
  }

  /** Forgets expired sign-ins and old rate-limit counters. */
  sweep() {
    const now = this.now();
    for (const s of this.sessions.values()) if (now - s.createdAt > this.ttl) this.drop(s);
    for (const [k, h] of this.hits) if (now - h.at >= 60_000) this.hits.delete(k);
  }

  private async start(provider: ProviderId, req: IncomingMessage, res: ServerResponse) {
    this.limit(req, 'start');
    const body = await readJson(req);
    const appRedirect = allowedAppRedirect(body.appRedirect);
    if (!appRedirect) throw new HttpError(400, 'bad_redirect', 'appRedirect must be bibbly://… or a loopback address such as http://127.0.0.1:<port>/callback.');
    this.sweep();
    if (this.sessions.size >= (this.o.maxSessions ?? 1000)) throw new HttpError(503, 'busy', 'Too many sign-ins in progress. Try again in a minute.');
    const app = this.app(provider);
    const pkce = app.pkce ? pkcePair() : null;
    const secret = token(32);
    const s: Session = {
      id: token(18), secretHash: sha(secret), provider, state: token(24), appRedirect, createdAt: this.now(), status: 'pending', failures: 0,
      ...(pkce ? { verifier: pkce.verifier } : {}),
    };
    this.sessions.set(s.id, s);
    this.byState.set(s.state, s.id);
    const authorizeUrl = buildAuthorizeUrl(app, { redirectUri: this.redirectUri(provider), state: s.state, ...(pkce ? { codeChallenge: pkce.challenge } : {}) });
    sendJson(res, 200, { sessionId: s.id, secret, authorizeUrl, expiresAt: s.createdAt + this.ttl });
  }

  private async callback(provider: ProviderId, url: URL, res: ServerResponse) {
    const state = url.searchParams.get('state') ?? '';
    const id = this.byState.get(state);
    const s = id ? this.live(id) : null;
    if (!s || s.provider !== provider || s.status !== 'pending') {
      sendPage(res, 400, 'This sign-in link has expired', 'Go back to Bibbly and connect again.');
      return;
    }
    this.byState.delete(state); // the provider's response can be used once
    const error = url.searchParams.get('error');
    if (error) {
      this.drop(s);
      const message = url.searchParams.get('error_description');
      redirect(res, s.appRedirect, { session: s.id, error, ...(message ? { message: message.slice(0, 300) } : {}) });
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      this.drop(s);
      redirect(res, s.appRedirect, { session: s.id, error: 'missing_code', message: `${PROVIDERS[provider].name} didn't send a sign-in code.` });
      return;
    }
    try {
      const { tokens } = await exchangeCode(this.app(provider), { code, redirectUri: this.redirectUri(provider), ...(s.verifier ? { codeVerifier: s.verifier } : {}) }, this.http, this.now());
      const completion = token(24);
      Object.assign(s, { status: 'done', tokens, completionHash: sha(completion) });
      redirect(res, s.appRedirect, { session: s.id, code: completion });
    } catch (err) {
      this.drop(s);
      const e = err instanceof ConnectorError ? err : null;
      redirect(res, s.appRedirect, { session: s.id, error: e?.code || 'exchange_failed', message: (e?.message ?? `${PROVIDERS[provider].name} didn't accept the sign-in.`).slice(0, 300) });
    }
  }

  private fail(s: Session) {
    if (++s.failures >= 5) this.drop(s);
  }

  private async collect(id: string, req: IncomingMessage, res: ServerResponse) {
    this.limit(req, 'collect');
    const body = await readJson(req);
    const s = this.live(id);
    if (!s) throw new HttpError(404, 'expired', 'This sign-in has expired. Connect again.');
    if (!matches(s.secretHash, String(req.headers['x-bibbly-session'] ?? ''))) { this.fail(s); throw new HttpError(403, 'forbidden', "This device didn't start this sign-in."); }
    if (s.status !== 'done') throw new HttpError(409, 'pending', 'Finish signing in in the browser first.');
    if (!matches(s.completionHash, typeof body.code === 'string' ? body.code : '')) { this.fail(s); throw new HttpError(403, 'forbidden', 'The sign-in response did not match. Connect again.'); }
    this.drop(s);
    sendJson(res, 200, { provider: s.provider, tokens: s.tokens });
  }

  private async refresh(provider: ProviderId, req: IncomingMessage, res: ServerResponse) {
    this.limit(req, 'refresh');
    const body = await readJson(req);
    const rt = typeof body.refreshToken === 'string' ? body.refreshToken : '';
    if (!rt || rt.length > 4096) throw new HttpError(400, 'bad_request', 'Send {"refreshToken": "…"}.');
    try {
      sendJson(res, 200, { tokens: await refreshTokens(this.app(provider), rt, this.http, this.now()) });
    } catch (err) {
      if (!(err instanceof ConnectorError)) throw err;
      throw new HttpError(err.status === 0 || err.status >= 500 ? 502 : 400, err.code || 'refresh_failed', err.message);
    }
  }
}

/**
 * Reads the broker settings from the environment:
 *   BIBBLY_PUBLIC_URL                     https://bibbly.example.com (redirect URIs are <this>/oauth/<provider>/callback)
 *   BIBBLY_GOOGLE_CLIENT_ID / _SECRET     Google Cloud OAuth client (Web application)
 *   BIBBLY_MICROSOFT_CLIENT_ID / _SECRET  Microsoft Entra app (Web platform); BIBBLY_MICROSOFT_TENANT (default: common)
 *   BIBBLY_SLACK_CLIENT_ID / _SECRET      Slack app
 *   BIBBLY_NOTION_CLIENT_ID / _SECRET     Notion public integration
 *   BIBBLY_LARK_APP_ID / _APP_SECRET      Lark or Feishu app; BIBBLY_LARK_REGION=feishu for Feishu
 *   BIBBLY_TRUST_PROXY=1                  behind a reverse proxy (client address from X-Forwarded-For)
 *   BIBBLY_PROVIDER_BASE_URL              testing only: send every provider call to one fake server
 */
export function brokerOptionsFromEnv(env: Record<string, string | undefined> = process.env): BrokerOptions {
  const clients: Partial<Record<ProviderId, ClientConfig>> = {};
  const add = (p: ProviderId, id?: string, secret?: string) => { if (id) clients[p] = { clientId: id, ...(secret ? { clientSecret: secret } : {}) }; };
  add('google', env.BIBBLY_GOOGLE_CLIENT_ID, env.BIBBLY_GOOGLE_CLIENT_SECRET);
  add('microsoft', env.BIBBLY_MICROSOFT_CLIENT_ID, env.BIBBLY_MICROSOFT_CLIENT_SECRET);
  add('slack', env.BIBBLY_SLACK_CLIENT_ID, env.BIBBLY_SLACK_CLIENT_SECRET);
  add('notion', env.BIBBLY_NOTION_CLIENT_ID, env.BIBBLY_NOTION_CLIENT_SECRET);
  add('lark', env.BIBBLY_LARK_APP_ID, env.BIBBLY_LARK_APP_SECRET);
  const endpoints = env.BIBBLY_PROVIDER_BASE_URL
    ? endpointsAt(env.BIBBLY_PROVIDER_BASE_URL)
    : defaultEndpoints({ ...(env.BIBBLY_MICROSOFT_TENANT ? { microsoftTenant: env.BIBBLY_MICROSOFT_TENANT } : {}), ...(env.BIBBLY_LARK_REGION === 'feishu' ? { larkRegion: 'feishu' as const } : {}) });
  return { clients, endpoints, trustProxy: env.BIBBLY_TRUST_PROXY === '1', ...(env.BIBBLY_PUBLIC_URL ? { publicUrl: env.BIBBLY_PUBLIC_URL } : {}) };
}
