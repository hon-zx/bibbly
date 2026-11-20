/**
 * Fake Google, Microsoft Graph, Slack, Notion and Lark servers for tests: just
 * the endpoints Bibbly uses, with in-memory state and the validation the real
 * APIs apply (auth, PKCE, Notion limits, Google Tasks date-only due dates,
 * Slack's two-step upload), and small pages so pagination is exercised.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';

type Json = Record<string, any>;

export interface Fake {
  url: string;
  close(): Promise<void>;
  /** Next API call for this provider answers 401 once (expired token). */
  expire(provider: Provider): void;
  clock: { now: number };
  google: { events: Map<string, Json>; lists: Json[]; tasks: Map<string, Json[]>; folders: Json[]; docs: Json[]; refreshes: number; tokenRequests: Json[]; revoked: string[] };
  microsoft: { events: Map<string, Json>; lists: Json[]; tasks: Map<string, Json[]>; messages: Json[]; refreshes: number; tokenRequests: Json[] };
  slack: { messages: Json[]; joined: Set<string>; uploads: Map<string, { length: number; content?: string }>; completed: Json[]; tokenRequests: Json[]; revoked: number };
  notion: { pages: Json[]; tokenRequests: Json[] };
  lark: { events: Map<string, Json>; lists: Json[]; tasks: Json[]; messages: Json[]; tokenRequests: Json[] };
  log: string[];
}

export type Provider = 'google' | 'microsoft' | 'slack' | 'notion' | 'lark';

const s256 = (v: string) => createHash('sha256').update(v).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims: Json) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

/** Starts the fakes on 127.0.0.1 (a free port unless one is given). */
export async function startFakes(opts: { port?: number } = {}): Promise<Fake> {
  let seq = 0;
  const next = (p: string) => `${p}-${++seq}`;
  const tokens: Record<Provider, Set<string>> = { google: new Set(), microsoft: new Set(), slack: new Set(), notion: new Set(), lark: new Set() };
  const expiring = new Set<Provider>();
  const codes = new Map<string, { provider: Provider; challenge?: string; redirectUri: string }>();
  const clock = { now: Date.UTC(2026, 10, 19, 9, 0, 0) };
  const iso = () => new Date(clock.now + seq).toISOString();
  const fake: Fake = {
    url: '', clock, log: [],
    close: () => new Promise(r => server.close(() => r())),
    expire: p => { expiring.add(p); },
    google: { events: new Map(), lists: [{ id: 'gl-default', title: 'My Tasks' }], tasks: new Map([['gl-default', []]]), folders: [], docs: [], refreshes: 0, tokenRequests: [], revoked: [] },
    microsoft: { events: new Map(), lists: [{ id: 'ml-default', displayName: 'Tasks', wellknownListName: 'defaultList' }], tasks: new Map([['ml-default', []]]), messages: [], refreshes: 0, tokenRequests: [] },
    slack: { messages: [], joined: new Set(['C1']), uploads: new Map(), completed: [], tokenRequests: [], revoked: 0 },
    notion: { pages: [{ id: 'page-1', title: 'Meeting notes', children: [] }], tokenRequests: [] },
    lark: { events: new Map(), lists: [], tasks: [], messages: [], tokenRequests: [] },
  };

  const issue = (p: Provider, prefix: string) => { const t = next(prefix); tokens[p].add(t); return t; };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', fake.url);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    // The real APIs Bibbly's browser preview calls answer CORS preflights; so do the fakes.
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE', 'Access-Control-Allow-Headers': String(req.headers['access-control-request-headers'] ?? '*'), 'Access-Control-Max-Age': '600' }).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const ctype = String(req.headers['content-type'] ?? '');
    const body: Json = ctype.includes('json') && raw ? JSON.parse(raw) : ctype.includes('form') ? Object.fromEntries(new URLSearchParams(raw)) : {};
    fake.log.push(`${method} ${path}`);
    const send = (status: number, obj?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(obj === undefined ? '' : JSON.stringify(obj));
    };
    const authed = (p: Provider) => {
      const h = String(req.headers.authorization ?? '');
      if (expiring.has(p)) { expiring.delete(p); send(401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired.' } }); return false; }
      if (!h.startsWith('Bearer ') || !tokens[p].has(h.slice(7))) { send(401, { error: { code: 'unauthorized', message: 'Invalid token' } }); return false; }
      return true;
    };
    const authorize = (p: Provider) => {
      const redirect = url.searchParams.get('redirect_uri')!;
      const code = next(`${p}-code`);
      codes.set(code, { provider: p, ...(url.searchParams.get('code_challenge') ? { challenge: url.searchParams.get('code_challenge')! } : {}), redirectUri: redirect });
      const to = new URL(redirect);
      to.searchParams.set('code', code);
      to.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { Location: to.toString() }).end();
    };
    const checkCode = (p: Provider, b: Json): string | null => {
      const c = codes.get(b.code);
      if (!c || c.provider !== p) return 'invalid_grant';
      if (c.redirectUri !== b.redirect_uri) return 'redirect_uri_mismatch';
      if (c.challenge && s256(String(b.code_verifier ?? '')) !== c.challenge) return 'invalid_pkce';
      codes.delete(b.code);
      return null;
    };

    try {
      /* ---------------- OAuth ---------------- */
      if (path === '/google/oauth/authorize' || path === '/microsoft/oauth/authorize' || path === '/slack/oauth/authorize' || path === '/notion/v1/oauth/authorize' || path === '/lark/accounts/authen/v1/authorize') {
        return authorize(path.startsWith('/google') ? 'google' : path.startsWith('/microsoft') ? 'microsoft' : path.startsWith('/slack') ? 'slack' : path.startsWith('/notion') ? 'notion' : 'lark');
      }
      if (path === '/google/oauth/token' || path === '/microsoft/oauth/token') {
        const p: Provider = path.startsWith('/google') ? 'google' : 'microsoft';
        fake[p].tokenRequests.push(body);
        if (!body.client_id) return send(400, { error: 'invalid_client' });
        if (body.grant_type === 'authorization_code') {
          const err = checkCode(p, body);
          if (err) return send(400, { error: err, error_description: err });
          const claims = p === 'google' ? { email: 'ada@example.com', sub: 'g-123' } : { preferred_username: 'grace@contoso.com', oid: 'ms-oid-1' };
          return send(200, { access_token: issue(p, `${p[0]}-at`), refresh_token: `${p[0]}-rt`, expires_in: 3600, token_type: 'Bearer', id_token: jwt(claims), scope: 'granted' });
        }
        if (body.grant_type === 'refresh_token') {
          if (body.refresh_token !== `${p[0]}-rt`) return send(400, { error: 'invalid_grant', error_description: 'Token has been revoked.' });
          fake[p].refreshes++;
          return send(200, { access_token: issue(p, `${p[0]}-at`), expires_in: 3600, token_type: 'Bearer' });
        }
        return send(400, { error: 'unsupported_grant_type' });
      }
      if (path === '/google/oauth/revoke' && method === 'POST') {
        fake.google.revoked.push(String(body.token ?? url.searchParams.get('token') ?? ''));
        return send(200, {});
      }
      if (path === '/slack/api/oauth.v2.access') {
        fake.slack.tokenRequests.push(body);
        if (!body.client_secret) return send(200, { ok: false, error: 'invalid_client_id' });
        const err = checkCode('slack', body);
        if (err) return send(200, { ok: false, error: err });
        return send(200, { ok: true, access_token: issue('slack', 'xoxb'), token_type: 'bot', scope: 'chat:write', bot_user_id: 'UBOT', app_id: 'A1', team: { id: 'T1', name: 'Acme' }, authed_user: { id: 'U1' } });
      }
      if (path === '/notion/v1/oauth/token') {
        fake.notion.tokenRequests.push({ ...body, authorization: req.headers.authorization });
        if (!String(req.headers.authorization ?? '').startsWith('Basic ')) return send(401, { object: 'error', code: 'unauthorized', message: 'Basic auth required' });
        const err = checkCode('notion', body);
        if (err) return send(400, { error: err });
        return send(200, { access_token: issue('notion', 'ntn'), token_type: 'bearer', bot_id: 'bot-1', workspace_name: 'Acme HQ', workspace_id: 'ws-1', owner: { type: 'user', user: { id: 'u1', person: { email: 'ada@example.com' } } } });
      }
      if (path === '/lark/open-apis/authen/v2/oauth/token') {
        fake.lark.tokenRequests.push(body);
        if (body.grant_type === 'authorization_code') {
          if (!body.client_secret) return send(200, { code: 20002, error: 'invalid_client', error_description: 'client secret missing' });
          const err = checkCode('lark', body);
          if (err) return send(200, { code: 20003, error: err, error_description: err });
          return send(200, { code: 0, access_token: issue('lark', 'l-at'), expires_in: 7200, refresh_token: 'l-rt', refresh_token_expires_in: 604800, token_type: 'Bearer', scope: 'offline_access' });
        }
        if (body.grant_type === 'refresh_token' && body.refresh_token === 'l-rt') return send(200, { code: 0, access_token: issue('lark', 'l-at'), expires_in: 7200, token_type: 'Bearer' });
        return send(200, { code: 20064, error: 'invalid_grant', error_description: 'refresh token invalid' });
      }

      /* ---------------- Google ---------------- */
      if (path.startsWith('/google/')) {
        if (!authed('google')) return;
        const g = fake.google;
        if (path === '/google/userinfo') return send(200, { email: 'ada@example.com', sub: 'g-123' });
        if (path === '/google/calendar/v3/calendars/primary' && method === 'GET') return send(200, { id: 'ada@example.com', summary: 'Ada' });
        let m = path.match(/^\/google\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
        if (m) {
          const id = m[2] ? decodeURIComponent(m[2]) : undefined;
          if (method === 'GET' && !id) {
            const min = Date.parse(url.searchParams.get('timeMin')!), max = Date.parse(url.searchParams.get('timeMax')!);
            if (url.searchParams.get('singleEvents') !== 'true') return send(400, { error: { message: 'singleEvents required for orderBy' } });
            const all = [...g.events.values()].filter(e => { const s = Date.parse(e.start.dateTime ?? e.start.date); return s >= min && s <= max; });
            const off = Number(url.searchParams.get('pageToken') ?? 0);
            return send(200, { items: all.slice(off, off + 2), ...(off + 2 < all.length ? { nextPageToken: String(off + 2) } : {}) });
          }
          if (method === 'POST') {
            const e: Json = { ...body, id: next('gev'), etag: `"${seq}"`, updated: iso(), status: 'confirmed', htmlLink: `https://calendar.google.com/event?eid=${seq}` };
            if (body.conferenceData?.createRequest) {
              if (url.searchParams.get('conferenceDataVersion') !== '1') return send(400, { error: { message: 'conferenceDataVersion=1 required' } });
              e.hangoutLink = 'https://meet.google.com/abc-defg-hij';
              e.conferenceData = { conferenceSolution: { key: { type: 'hangoutsMeet' } }, entryPoints: [{ entryPointType: 'video', uri: e.hangoutLink }] };
            }
            g.events.set(e.id, e);
            return send(200, e);
          }
          const cur = id ? g.events.get(id) : undefined;
          if (!cur) return send(method === 'DELETE' ? 410 : 404, { error: { message: 'Not found' } });
          if (method === 'PATCH') { const e = { ...cur, ...body, etag: `"${++seq}"`, updated: iso() }; g.events.set(cur.id, e); return send(200, e); }
          if (method === 'DELETE') { g.events.delete(cur.id); return send(204); }
        }
        if (path === '/google/tasks/v1/users/@me/lists') {
          if (method === 'POST') { const l = { id: next('gl'), title: body.title }; g.lists.push(l); g.tasks.set(l.id, []); return send(200, l); }
          return send(200, { items: g.lists });
        }
        m = path.match(/^\/google\/tasks\/v1\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/);
        if (m) {
          const list = g.tasks.get(decodeURIComponent(m[1]!));
          if (!list) return send(404, { error: { message: 'Task list not found' } });
          const id = m[2] ? decodeURIComponent(m[2]) : undefined;
          const dateOnly = (d: unknown) => (typeof d === 'string' ? `${d.slice(0, 10)}T00:00:00.000Z` : d);
          if (method === 'GET' && !id) {
            const off = Number(url.searchParams.get('pageToken') ?? 0);
            return send(200, { items: list.slice(off, off + 2), ...(off + 2 < list.length ? { nextPageToken: String(off + 2) } : {}) });
          }
          if (method === 'POST') {
            const t: Json = { id: next('gt'), title: body.title, notes: body.notes, status: body.status ?? 'needsAction', updated: iso(), webViewLink: `https://tasks.google.com/task/${seq}` };
            if (body.due) t.due = dateOnly(body.due);
            if (t.status === 'completed') t.completed = iso();
            list.push(t);
            return send(200, t);
          }
          const i = list.findIndex(t => t.id === id);
          if (i < 0) return send(404, { error: { message: 'Task not found' } });
          if (method === 'PATCH') {
            const t: Json = { ...list[i], ...body, updated: iso() };
            if (body.due === null) delete t.due; else if (body.due) t.due = dateOnly(body.due);
            if (t.status === 'completed' && !t.completed) t.completed = iso();
            if (body.completed === null || t.status !== 'completed') delete t.completed;
            list[i] = t;
            return send(200, t);
          }
          if (method === 'DELETE') { list.splice(i, 1); return send(204); }
        }
        if (path === '/google/drive/v3/files') {
          if (method === 'GET') {
            const name = /name = '([^']+)'/.exec(url.searchParams.get('q') ?? '')?.[1];
            return send(200, { files: g.folders.filter(f => f.name === name).map(f => ({ id: f.id })) });
          }
          const f = { id: next('folder'), name: body.name, mimeType: body.mimeType };
          g.folders.push(f);
          return send(200, { id: f.id });
        }
        if (path === '/google/upload/drive/v3/files' && method === 'POST') {
          const boundary = /boundary=([^;]+)/.exec(ctype)?.[1];
          if (url.searchParams.get('uploadType') !== 'multipart' || !boundary) return send(400, { error: { message: 'Bad upload' } });
          const parts = raw.split(`--${boundary}`).slice(1, -1).map(p => p.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''));
          const meta = JSON.parse(parts[0]!);
          const doc = { id: next('doc'), name: meta.name, mimeType: meta.mimeType, parents: meta.parents, html: parts[1] };
          g.docs.push(doc);
          return send(200, { id: doc.id, webViewLink: `https://docs.google.com/document/d/${doc.id}/edit` });
        }
        return send(404, { error: { message: `No fake for ${method} ${path}` } });
      }

      /* ---------------- Microsoft Graph ---------------- */
      if (path.startsWith('/graph/v1.0/')) {
        if (!authed('microsoft')) return;
        const ms = fake.microsoft;
        const p = path.slice('/graph/v1.0'.length);
        const page = (items: Json[], size = 2) => {
          const off = Number(url.searchParams.get('$skiptoken') ?? 0);
          const nextUrl = new URL(url.toString());
          nextUrl.searchParams.set('$skiptoken', String(off + size));
          return { value: items.slice(off, off + size), ...(off + size < items.length ? { '@odata.nextLink': nextUrl.toString() } : {}) };
        };
        if (p === '/me') return send(200, { id: 'ms-oid-1', mail: 'grace@contoso.com', displayName: 'Grace' });
        if (p === '/me/calendar') return send(200, { id: 'cal-1', name: 'Calendar' });
        if (/^\/me\/(calendar|calendars\/[^/]+)\/calendarView$/.test(p)) {
          if (!String(req.headers.prefer ?? '').includes('outlook.timezone="UTC"')) return send(400, { error: { code: 'BadRequest', message: 'Expected UTC preference' } });
          const min = Date.parse(url.searchParams.get('startDateTime')!), max = Date.parse(url.searchParams.get('endDateTime')!);
          const all = [...ms.events.values()].filter(e => { const s = Date.parse(`${e.start.dateTime}Z`); return s >= min && s <= max; });
          return send(200, page(all));
        }
        if (/^\/me\/(calendar|calendars\/[^/]+)\/events$/.test(p) && method === 'POST') {
          const e: Json = { ...body, id: next('mev'), changeKey: `ck${seq}`, lastModifiedDateTime: iso(), webLink: `https://outlook.office.com/calendar/item/${seq}` };
          if (body.isOnlineMeeting) e.onlineMeeting = { joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting' };
          ms.events.set(e.id, e);
          return send(201, e);
        }
        let m = p.match(/^\/me\/events\/([^/]+)$/);
        if (m) {
          const cur = ms.events.get(decodeURIComponent(m[1]!));
          if (!cur) return send(404, { error: { code: 'ErrorItemNotFound', message: 'Not found' } });
          if (method === 'PATCH') { const e = { ...cur, ...body, changeKey: `ck${++seq}`, lastModifiedDateTime: iso() }; ms.events.set(cur.id, e); return send(200, e); }
          if (method === 'DELETE') { ms.events.delete(cur.id); return send(204); }
        }
        if (p === '/me/todo/lists') {
          if (method === 'POST') { const l = { id: next('ml'), displayName: body.displayName }; ms.lists.push(l); ms.tasks.set(l.id, []); return send(201, l); }
          return send(200, page(ms.lists, 10));
        }
        m = p.match(/^\/me\/todo\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/);
        if (m) {
          const list = ms.tasks.get(decodeURIComponent(m[1]!));
          if (!list) return send(404, { error: { code: 'ErrorItemNotFound', message: 'List not found' } });
          const id = m[2] ? decodeURIComponent(m[2]) : undefined;
          if (method === 'GET' && !id) return send(200, page(list));
          if (method === 'POST') { const t = { ...body, id: next('mt'), lastModifiedDateTime: iso(), ...(body.status === 'completed' ? { completedDateTime: { dateTime: iso().replace('Z', ''), timeZone: 'UTC' } } : {}) }; list.push(t); return send(201, t); }
          const i = list.findIndex(t => t.id === id);
          if (i < 0) return send(404, { error: { code: 'ErrorItemNotFound', message: 'Task not found' } });
          if (method === 'PATCH') { list[i] = { ...list[i], ...body, lastModifiedDateTime: iso() }; return send(200, list[i]); }
          if (method === 'DELETE') { list.splice(i, 1); return send(204); }
        }
        if (p === '/me/joinedTeams') return send(200, { value: [{ id: 'team-1', displayName: 'Product' }] });
        if (p === '/teams/team-1/channels') return send(200, { value: [{ id: 'chan-1', displayName: 'General' }, { id: 'chan-2', displayName: 'Launch' }] });
        m = p.match(/^\/teams\/([^/]+)\/channels\/([^/]+)\/messages$/);
        if (m && method === 'POST') {
          if (body.body?.contentType !== 'html') return send(400, { error: { code: 'BadRequest', message: 'html expected' } });
          const msg = { id: next('msg'), team: m[1], channel: m[2], body: body.body, subject: body.subject };
          ms.messages.push(msg);
          return send(201, { id: msg.id, webUrl: `https://teams.microsoft.com/l/message/${m[2]}/${msg.id}` });
        }
        return send(404, { error: { code: 'NotFound', message: `No fake for ${method} ${p}` } });
      }

      /* ---------------- Slack ---------------- */
      if (path.startsWith('/slack/upload/')) {
        const id = path.split('/').pop()!;
        const up = fake.slack.uploads.get(id);
        if (!up) return send(404);
        if (Buffer.byteLength(raw) !== up.length) { res.writeHead(400).end('length mismatch'); return; }
        up.content = raw;
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end(`OK - ${up.length}`);
        return;
      }
      if (path.startsWith('/slack/api/')) {
        if (!authed('slack')) return;
        const sl = fake.slack;
        const methodName = path.slice('/slack/api/'.length);
        const q = Object.fromEntries(url.searchParams);
        switch (methodName) {
          case 'auth.test': return send(200, { ok: true, url: 'https://acme.slack.com/', team: 'Acme', team_id: 'T1', user: 'bibbly', user_id: 'UBOT' });
          case 'auth.revoke': tokens.slack.delete(String(req.headers.authorization).slice(7)); sl.revoked++; return send(200, { ok: true, revoked: true });
          case 'conversations.list': {
            const all = [{ id: 'C1', name: 'general', is_member: true }, { id: 'C2', name: 'product', is_member: false }, { id: 'C3', name: 'leadership', is_private: true, is_member: true }];
            const off = Number(q.cursor ?? 0);
            return send(200, { ok: true, channels: all.slice(off, off + 2), response_metadata: { next_cursor: off + 2 < all.length ? String(off + 2) : '' } });
          }
          case 'conversations.join': sl.joined.add(body.channel); return send(200, { ok: true, channel: { id: body.channel } });
          case 'chat.postMessage': {
            if (!['C1', 'C2', 'C3'].includes(body.channel)) return send(200, { ok: false, error: 'channel_not_found' });
            if (!sl.joined.has(body.channel)) return send(200, { ok: false, error: 'not_in_channel' });
            if (!Array.isArray(body.blocks) || body.blocks.length > 50) return send(200, { ok: false, error: 'invalid_blocks' });
            const ts = `1763542800.${String(++seq).padStart(6, '0')}`;
            sl.messages.push({ ...body, ts });
            return send(200, { ok: true, channel: body.channel, ts });
          }
          case 'files.getUploadURLExternal': {
            if (!q.filename || !q.length) return send(200, { ok: false, error: 'invalid_arguments' });
            const id = next('F');
            sl.uploads.set(id, { length: Number(q.length) });
            return send(200, { ok: true, upload_url: `${fake.url}/slack/upload/${id}`, file_id: id });
          }
          case 'files.completeUploadExternal': {
            const f = body.files?.[0];
            if (!f || !sl.uploads.get(f.id)?.content) return send(200, { ok: false, error: 'file_not_found' });
            sl.completed.push(body);
            return send(200, { ok: true, files: [{ id: f.id, title: f.title }] });
          }
          case 'chat.getPermalink': return send(200, { ok: true, permalink: `https://acme.slack.com/archives/${q.channel}/p${String(q.message_ts).replace('.', '')}` });
          default: return send(200, { ok: false, error: 'unknown_method' });
        }
      }

      /* ---------------- Notion ---------------- */
      if (path.startsWith('/notion/v1/')) {
        if (!authed('notion')) return;
        if (req.headers['notion-version'] !== '2026-03-11') return send(400, { object: 'error', code: 'missing_version', message: 'Notion-Version header failed validation.' });
        const n = fake.notion;
        const checkBlocks = (children: Json[] | undefined): string | null => {
          if (!children) return null;
          if (children.length > 100) return 'body.children.length should be ≤ 100';
          for (const b of children) for (const rt of b[b.type]?.rich_text ?? []) if ((rt.text?.content ?? '').length > 2000) return 'rich_text content should be ≤ 2000 characters';
          return null;
        };
        if (path === '/notion/v1/search') {
          if (body.filter?.value !== 'page') return send(400, { object: 'error', code: 'validation_error', message: 'filter value' });
          return send(200, { object: 'list', results: n.pages.filter(p => !p.parent).map(p => ({ object: 'page', id: p.id, url: `https://www.notion.so/${p.id}`, properties: { title: { id: 'title', type: 'title', title: [{ plain_text: p.title }] } } })), has_more: false, next_cursor: null });
        }
        if (path === '/notion/v1/pages' && method === 'POST') {
          if (!n.pages.some(p => p.id === body.parent?.page_id)) return send(404, { object: 'error', code: 'object_not_found', message: 'Could not find page. Make sure the relevant pages and databases are shared with your integration.' });
          const err = checkBlocks(body.children);
          if (err) return send(400, { object: 'error', code: 'validation_error', message: err });
          const page = { id: next('np'), parent: body.parent.page_id, title: body.properties?.title?.title?.[0]?.text?.content, children: [...(body.children ?? [])] };
          n.pages.push(page);
          return send(200, { object: 'page', id: page.id, url: `https://www.notion.so/${page.id}` });
        }
        const m = path.match(/^\/notion\/v1\/blocks\/([^/]+)\/children$/);
        if (m && method === 'PATCH') {
          const page = n.pages.find(p => p.id === m[1]);
          if (!page) return send(404, { object: 'error', code: 'object_not_found', message: 'Not found' });
          const err = checkBlocks(body.children);
          if (err) return send(400, { object: 'error', code: 'validation_error', message: err });
          page.children.push(...body.children);
          return send(200, { object: 'list', results: body.children });
        }
        if (path === '/notion/v1/users/me') return send(200, { object: 'user', id: 'bot-1', type: 'bot', name: 'Bibbly', bot: { workspace_name: 'Acme HQ' } });
        return send(404, { object: 'error', code: 'object_not_found', message: `No fake for ${method} ${path}` });
      }

      /* ---------------- Lark ---------------- */
      if (path.startsWith('/lark/open-apis/')) {
        if (!authed('lark')) return;
        const lk = fake.lark;
        const p = path.slice('/lark/open-apis'.length);
        const ok = (data: unknown = {}) => send(200, { code: 0, msg: 'success', data });
        if (p === '/authen/v1/user_info') return ok({ name: '林', en_name: 'Lin', email: 'lin@acme.example', open_id: 'ou_1' });
        if (p === '/calendar/v4/calendars/primary' && method === 'POST') return ok({ calendars: [{ calendar: { calendar_id: 'lcal-1', summary: 'Lin' }, user_id: 'u1' }] });
        let m = p.match(/^\/calendar\/v4\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
        if (m) {
          if (m[1] !== 'lcal-1') return send(200, { code: 193001, msg: 'calendar not found' });
          const id = m[2] ? decodeURIComponent(m[2]) : undefined;
          if (method === 'GET' && !id) {
            const min = Number(url.searchParams.get('start_time')), max = Number(url.searchParams.get('end_time'));
            return ok({ items: [...lk.events.values()].filter(e => Number(e.start_time.timestamp) >= min && Number(e.start_time.timestamp) <= max), has_more: false });
          }
          if (method === 'POST') {
            const e = { ...body, event_id: next('lev'), status: 'confirmed', app_link: `https://applink.larksuite.com/client/calendar/event/detail?eventId=${seq}`, ...(body.vchat?.vc_type === 'vc' ? { vchat: { vc_type: 'vc', meeting_url: 'https://vc.larksuite.com/j/123456789' } } : {}) };
            lk.events.set(e.event_id, e);
            return ok({ event: e });
          }
          const cur = id ? lk.events.get(id) : undefined;
          if (!cur) return send(200, { code: 193002, msg: 'event not found' });
          if (method === 'PATCH') { const e = { ...cur, ...body }; lk.events.set(cur.event_id, e); return ok({ event: e }); }
          if (method === 'DELETE') { lk.events.delete(cur.event_id); return ok(); }
        }
        if (p === '/task/v2/tasklists') {
          if (method === 'POST') { const l = { guid: next('ltl'), name: body.name }; lk.lists.push(l); return ok({ tasklist: l }); }
          return ok({ items: lk.lists, has_more: false });
        }
        m = p.match(/^\/task\/v2\/tasklists\/([^/]+)\/tasks$/);
        if (m) return ok({ items: lk.tasks.filter(t => t.tasklist === m![1]), has_more: false });
        if (p === '/task/v2/tasks' && method === 'POST') {
          const list = body.tasklists?.[0]?.tasklist_guid;
          if (!lk.lists.some(l => l.guid === list)) return send(200, { code: 1470400, msg: 'tasklist not found' });
          const t = { guid: next('ltk'), summary: body.summary, description: body.description, due: body.due, completed_at: body.completed_at ?? '0', updated_at: String(clock.now + seq), tasklist: list };
          lk.tasks.push(t);
          return ok({ task: t });
        }
        m = p.match(/^\/task\/v2\/tasks\/([^/]+)$/);
        if (m) {
          const i = lk.tasks.findIndex(t => t.guid === m![1]);
          if (i < 0) return send(200, { code: 1470404, msg: 'task not found' });
          if (method === 'PATCH') {
            const t = { ...lk.tasks[i] };
            for (const f of body.update_fields ?? []) { if (body.task?.[f] === undefined) delete t[f]; else t[f] = body.task[f]; }
            t.updated_at = String(clock.now + ++seq);
            lk.tasks[i] = t;
            return ok({ task: t });
          }
          if (method === 'DELETE') { lk.tasks.splice(i, 1); return ok(); }
        }
        if (p === '/im/v1/chats') return ok({ items: [{ chat_id: 'oc_1', name: 'Launch team' }], has_more: false });
        if (p === '/im/v1/messages' && method === 'POST') {
          if (url.searchParams.get('receive_id_type') !== 'chat_id') return send(200, { code: 230001, msg: 'invalid receive_id_type' });
          if (body.receive_id !== 'oc_1') return send(200, { code: 230002, msg: 'chat not found' });
          const content = JSON.parse(body.content);
          if (body.msg_type !== 'post' || !content.en_us?.content) return send(200, { code: 230001, msg: 'invalid post content' });
          lk.messages.push({ ...body, content });
          return ok({ message_id: next('om') });
        }
        return send(200, { code: 404, msg: `No fake for ${method} ${p}` });
      }
      send(404, { error: `No fake for ${method} ${path}` });
    } catch (err) {
      send(500, { error: String(err) });
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(opts.port ?? 0, '127.0.0.1', () => resolve()); });
  const addr = server.address();
  fake.url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  return fake;
}

/** Follows the fake consent page's redirect, standing in for the user's browser. */
export async function visit(url: string): Promise<void> {
  const res = await fetch(url, { redirect: 'manual' });
  const to = res.headers.get('location');
  if (to) await fetch(to);
}
