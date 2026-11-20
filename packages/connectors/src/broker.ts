/**
 * Client for the Bibbly server's OAuth broker (apps/server). The server holds
 * each app's client secret, runs the redirect and exchanges the code; the
 * device collects the tokens once. Used on mobile for every provider, and on
 * desktop for Slack, Notion and Lark, whose token exchange needs a secret.
 *
 * Collecting needs two things: the secret this device got when it started the
 * sign-in, and the completion code the server adds to the app redirect
 * (bibbly://oauth on a phone, a loopback address on desktop) when the browser
 * comes back. A sign-in link sent to someone else is useless to the sender,
 * and an app that intercepts the redirect can't collect without the secret.
 */
import { ConnectorError } from './http.js';
import type { ProviderId, TokenSet } from './types.js';

export interface BrokerSession { sessionId: string; secret: string; authorizeUrl: string; expiresAt?: number }

export interface BrokerProvider { id: ProviderId; name: string; configured: boolean }

const SOURCE = 'Bibbly server';

export class BrokerClient {
  constructor(private readonly baseUrl: string, private readonly opts: { fetch?: typeof fetch } = {}) {}

  private url(path: string) { return `${this.baseUrl.replace(/\/+$/, '')}${path}`; }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(this.url(path), init);
    } catch {
      throw new ConnectorError(`Couldn't reach the Bibbly server at ${this.baseUrl}. Check the server address in Settings.`, SOURCE, 0, 'network', true);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new ConnectorError(String(body.message ?? `The Bibbly server answered ${res.status}.`), SOURCE, res.status, body.code ? String(body.code) : undefined, res.status >= 500);
    return body as T;
  }

  /** The apps this server can connect (it has client credentials for them). */
  async providers(): Promise<BrokerProvider[]> {
    const r = await this.json<{ providers?: BrokerProvider[] }>('/oauth/providers');
    return r.providers ?? [];
  }

  /** Starts a sign-in. The browser returns to `appRedirect` with `session` and `code` (or `error`). */
  start(provider: ProviderId, appRedirect: string): Promise<BrokerSession> {
    return this.json<BrokerSession>(`/oauth/${provider}/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appRedirect }),
    });
  }

  /** Collects the tokens with the completion code from the app redirect. Works once. */
  async collect(s: BrokerSession, code: string): Promise<TokenSet> {
    const r = await this.json<{ tokens: TokenSet }>(`/oauth/session/${encodeURIComponent(s.sessionId)}/collect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bibbly-Session': s.secret }, body: JSON.stringify({ code }),
    });
    return r.tokens;
  }

  /** Gets a new access token; the server adds the client secret. */
  async refresh(provider: ProviderId, refreshToken: string): Promise<TokenSet> {
    const r = await this.json<{ tokens: TokenSet }>(`/oauth/${provider}/refresh`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }),
    });
    return r.tokens;
  }
}

/**
 * Reads the app redirect (`bibbly://oauth?session=…&code=…`, or the loopback
 * request's query) and returns the completion code, or throws the reason the
 * sign-in didn't finish.
 */
export function completionCode(redirect: string | URLSearchParams, s: BrokerSession): string {
  const q = typeof redirect === 'string' ? new URL(redirect).searchParams : redirect;
  const error = q.get('error');
  if (error) {
    const cancelled = error === 'access_denied' || error === 'cancelled';
    throw new ConnectorError(cancelled ? 'Sign-in was cancelled.' : (q.get('message') || `Sign-in failed (${error}).`), SOURCE, 400, cancelled ? 'cancelled' : error);
  }
  const code = q.get('code');
  if (!code || q.get('session') !== s.sessionId) throw new ConnectorError('The sign-in response did not match. Try again.', SOURCE, 400, 'mismatch');
  return code;
}
