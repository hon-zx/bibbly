/** A small fetch wrapper: bearer auth with one refresh on 401, retries on 429/5xx, readable errors. */

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status: number,
    readonly code?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }

  /** The app no longer accepts the token: the user has to connect again. */
  get needsReconnect(): boolean {
    return this.status === 401 || ['invalid_grant', 'invalid_auth', 'token_revoked', 'account_inactive', 'unauthorized', 'token_expired'].includes(this.code ?? '');
  }
}

/** Supplies access tokens for API calls; `refresh` is called once after a 401. */
export interface AuthSource {
  token(): Promise<string>;
  refresh?(): Promise<string>;
}

export interface HttpOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export interface Req {
  method?: string;
  url: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  json?: unknown;
  form?: Record<string, string>;
  body?: string;
  headers?: Record<string, string>;
  auth?: AuthSource | null;
  /** What to read from a successful response. */
  expect?: 'json' | 'text' | 'none';
}

type ErrorParser = (status: number, body: string) => { message: string; code?: string };

export function withQuery(url: string, query?: Req['query']): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  return u.toString();
}

const defaultError: ErrorParser = (status, body) => {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const e = j.error as Record<string, unknown> | string | undefined;
    if (typeof e === 'string') return { message: String(j.error_description ?? j.message ?? e), code: e };
    if (e && typeof e === 'object') return { message: String(e.message ?? e.code ?? `HTTP ${status}`), code: e.code ? String(e.code) : String(e.status ?? '') || undefined };
    if (typeof j.message === 'string') return { message: j.message, code: typeof j.code === 'string' ? j.code : undefined };
  } catch { /* not JSON */ }
  return { message: body.slice(0, 200) || `HTTP ${status}` };
};

export class Http {
  constructor(readonly provider: string, private readonly opts: HttpOptions = {}, private readonly parseError: ErrorParser = defaultError) {}

  private sleep(ms: number) { return (this.opts.sleep ?? (t => new Promise(r => setTimeout(r, t))))(ms); }

  async request<T>(r: Req): Promise<T> {
    const max = this.opts.maxRetries ?? 3;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { Accept: 'application/json', ...r.headers };
      if (r.auth) headers.Authorization = `Bearer ${await r.auth.token()}`;
      let body: string | undefined;
      if (r.json !== undefined) { headers['Content-Type'] ??= 'application/json'; body = JSON.stringify(r.json); }
      else if (r.form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(r.form).toString(); }
      else if (r.body !== undefined) body = r.body;
      let res: Response;
      try {
        res = await (this.opts.fetch ?? fetch)(withQuery(r.url, r.query), { method: r.method ?? (body !== undefined ? 'POST' : 'GET'), headers, ...(body !== undefined ? { body } : {}) });
      } catch (err) {
        if (attempt < max) { await this.sleep(400 * 2 ** attempt); continue; }
        throw new ConnectorError(`Couldn't reach ${this.provider}: ${err instanceof Error ? err.message : String(err)}`, this.provider, 0, 'network', true);
      }
      if (res.status === 401 && r.auth?.refresh && !refreshed) { refreshed = true; await r.auth.refresh(); continue; }
      if ((res.status === 429 || res.status >= 500) && attempt < max) {
        const after = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 500 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        const e = this.parseError(res.status, text);
        throw new ConnectorError(e.message, this.provider, res.status, e.code, res.status === 429 || res.status >= 500);
      }
      if (r.expect === 'none' || (!text && r.expect !== 'text')) return undefined as T;
      if (r.expect === 'text') return text as T;
      try { return JSON.parse(text) as T; } catch { throw new ConnectorError(`${this.provider} sent a response Bibbly couldn't read`, this.provider, res.status, 'bad_json'); }
    }
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** UTF-8 string to base64, without btoa or Buffer. */
export function encodeBase64Utf8(input: string): string {
  const bytes = Array.from(unescapeUtf8(input));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const v = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(v >> 18) & 63]! + B64[(v >> 12) & 63]! + (i + 1 < bytes.length ? B64[(v >> 6) & 63]! : '=') + (i + 2 < bytes.length ? B64[v & 63]! : '=');
  }
  return out;
}

function unescapeUtf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return Uint8Array.from(out);
}

/** Base64 or base64url to a UTF-8 string, without atob (missing on some React Native engines). */
export function decodeBase64Utf8(input: string): string {
  const clean = input.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map(k => B64.indexOf(clean[i + k] ?? 'A'));
    const v = (n[0]! << 18) | (n[1]! << 12) | (n[2]! << 6) | n[3]!;
    bytes.push((v >> 16) & 255);
    if (i + 2 < clean.length) bytes.push((v >> 8) & 255);
    if (i + 3 < clean.length) bytes.push(v & 255);
  }
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const c = bytes[i]!;
    const len = c < 0x80 ? 1 : c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : 2;
    let cp = len === 1 ? c : c & (0xff >> (len + 1));
    for (let k = 1; k < len; k++) cp = (cp << 6) | ((bytes[i + k] ?? 0) & 0x3f);
    out += String.fromCodePoint(cp);
    i += len;
  }
  return out;
}

/** Reads the payload of a JWT (id_token) without verifying it: only for showing who connected. */
export function jwtClaims(token: string | undefined): Record<string, unknown> {
  const part = token?.split('.')[1];
  if (!part) return {};
  try {
    return JSON.parse(decodeBase64Utf8(part)) as Record<string, unknown>;
  } catch {
    return {};
  }
}
