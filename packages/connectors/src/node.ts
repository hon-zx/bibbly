/**
 * Node-only helpers for the desktop app: PKCE values, and sign-in through a
 * one-off local server (the browser returns to http://127.0.0.1:<port>/callback
 * on this machine), either straight from the provider (Google, Microsoft) or
 * via the Bibbly server's broker (Slack, Notion, Lark).
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { completionCode, type BrokerClient, type BrokerSession } from './broker.js';
import { buildAuthorizeUrl, type OAuthApp } from './oauth.js';
import type { ProviderId, TokenSet } from './types.js';

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export const randomState = (): string => b64url(randomBytes(18));

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><body style="font:16px system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0;background:#EDF4F1;color:#12302C"><div style="text-align:center;max-width:420px;padding:0 16px"><h1 style="font-size:22px">${esc(title)}</h1><p>${esc(body)}</p></div></body>`;

export interface SignInOptions {
  /** Opens the system browser. */
  open: (url: string) => unknown;
  timeoutMs?: number;
  appName?: string;
  /** Cancels the wait (the user closed the browser, or pressed Cancel). */
  signal?: AbortSignal;
}

/**
 * Starts a local server, lets `begin` open the browser with its redirect URI,
 * and resolves with the query of the browser's return to /callback. `check`
 * returns why the response is unusable, or null.
 */
export function receiveRedirect(o: SignInOptions & { begin: (redirectUri: string) => Promise<void> | void; check: (q: URLSearchParams) => string | null }): Promise<URLSearchParams> {
  const appName = o.appName ?? 'Bibbly';
  return new Promise((resolve, reject) => {
    let done = false;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback' || done) { res.writeHead(404).end(); return; }
      const problem = o.check(url.searchParams);
      res.writeHead(problem ? 400 : 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end(problem ? page('Not connected', `${problem} You can close this tab.`) : page('Done', `You can close this tab and go back to ${appName}.`));
      finish(problem ? new Error(problem) : null, url.searchParams);
    });
    const timer = setTimeout(() => finish(new Error('Sign-in timed out. Try again.')), o.timeoutMs ?? 5 * 60_000);
    function finish(err: Error | null, q?: URLSearchParams) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      if (err) reject(err);
      else resolve(q!);
    }
    server.on('error', err => finish(err));
    if (o.signal?.aborted) { finish(new Error('Sign-in cancelled.')); return; }
    o.signal?.addEventListener('abort', () => finish(new Error('Sign-in cancelled.')), { once: true });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      Promise.resolve()
        .then(() => o.begin(`http://127.0.0.1:${port}/callback`))
        .catch(err => finish(err instanceof Error ? err : new Error(String(err))));
    });
  });
}

export interface LoopbackResult {
  code: string;
  redirectUri: string;
  codeVerifier?: string;
}

/** Signs in straight with the provider (PKCE where supported) and returns the authorization code. */
export async function loopbackAuthorize(app: OAuthApp, opts: SignInOptions): Promise<LoopbackResult> {
  const state = randomState();
  const pkce = app.pkce ? pkcePair() : null;
  let redirectUri = '';
  const q = await receiveRedirect({
    ...opts,
    begin: async uri => {
      redirectUri = uri;
      await opts.open(buildAuthorizeUrl(app, { redirectUri: uri, state, ...(pkce ? { codeChallenge: pkce.challenge } : {}) }));
    },
    check: q => {
      const error = q.get('error');
      if (error) return error === 'access_denied' ? 'Sign-in was cancelled.' : `The app said: ${q.get('error_description') ?? error}.`;
      return q.get('code') && q.get('state') === state ? null : 'The sign-in response did not match. Try again.';
    },
  });
  return { code: q.get('code')!, redirectUri, ...(pkce ? { codeVerifier: pkce.verifier } : {}) };
}

/** Signs in through the Bibbly server's broker, which holds the client secret. */
export async function brokerAuthorize(broker: BrokerClient, provider: ProviderId, opts: SignInOptions): Promise<TokenSet> {
  let session: BrokerSession | null = null;
  const q = await receiveRedirect({
    ...opts,
    begin: async uri => {
      session = await broker.start(provider, uri);
      await opts.open(session.authorizeUrl);
    },
    check: q => {
      if (!session) return 'The sign-in response did not match. Try again.';
      try { completionCode(q, session); return null; } catch (err) { return err instanceof Error ? err.message : String(err); }
    },
  });
  return broker.collect(session!, completionCode(q, session!));
}
