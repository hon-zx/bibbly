/**
 * OAuth 2.0 authorization-code flow, shared by the desktop app (loopback
 * redirect), the Bibbly server (the broker that holds client secrets) and tests.
 * PKCE values come from the caller, so this file needs no crypto and runs in
 * React Native too (see node.ts for generating them).
 */
import { ConnectorError, encodeBase64Utf8, Http } from './http.js';
import type { ProviderId, TokenSet } from './types.js';

export interface OAuthApp {
  provider: ProviderId;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  /** Absent for public clients (Microsoft desktop apps). */
  clientSecret?: string;
  scopes: string[];
  /** Slack and Lark separate scopes with commas or spaces; default is a space. */
  scopeSeparator?: string;
  /** How the token endpoint wants client credentials. */
  tokenAuth: 'body' | 'basic';
  /** Encoding of the token request. */
  tokenFormat: 'form' | 'json';
  pkce: boolean;
  extraAuthorizeParams?: Record<string, string>;
}

export interface AuthorizeParams {
  redirectUri: string;
  state: string;
  codeChallenge?: string;
}

export function buildAuthorizeUrl(app: OAuthApp, p: AuthorizeParams): string {
  const u = new URL(app.authorizeUrl);
  u.searchParams.set('client_id', app.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', p.state);
  if (app.scopes.length) u.searchParams.set('scope', app.scopes.join(app.scopeSeparator ?? ' '));
  if (app.pkce && p.codeChallenge) {
    u.searchParams.set('code_challenge', p.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [k, v] of Object.entries(app.extraAuthorizeParams ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

function credentials(app: OAuthApp, params: Record<string, string>): { headers: Record<string, string>; params: Record<string, string> } {
  if (app.tokenAuth === 'basic' && app.clientSecret) {
    return { headers: { Authorization: `Basic ${encodeBase64Utf8(`${app.clientId}:${app.clientSecret}`)}` }, params };
  }
  return { headers: {}, params: { ...params, client_id: app.clientId, ...(app.clientSecret ? { client_secret: app.clientSecret } : {}) } };
}

async function tokenRequest(app: OAuthApp, params: Record<string, string>, http: Http, now: number): Promise<{ tokens: TokenSet; raw: Record<string, unknown> }> {
  const c = credentials(app, params);
  const raw = await http.request<Record<string, unknown>>({
    method: 'POST', url: app.tokenUrl, headers: c.headers,
    ...(app.tokenFormat === 'json' ? { json: c.params } : { form: c.params }),
  });
  return { tokens: parseTokenResponse(app.provider, raw, now), raw };
}

export function exchangeCode(app: OAuthApp, p: { code: string; redirectUri: string; codeVerifier?: string }, http: Http, now = Date.now()) {
  return tokenRequest(app, {
    grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri,
    ...(app.pkce && p.codeVerifier ? { code_verifier: p.codeVerifier } : {}),
  }, http, now);
}

export async function refreshTokens(app: OAuthApp, refreshToken: string, http: Http, now = Date.now()): Promise<TokenSet> {
  const { tokens } = await tokenRequest(app, {
    grant_type: 'refresh_token', refresh_token: refreshToken,
    ...(app.provider === 'microsoft' ? { scope: app.scopes.join(' ') } : {}),
  }, http, now);
  // Most providers keep the old refresh token valid unless they send a new one.
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined);

/** Normalises the different token responses (Slack wraps errors in ok:false, Lark in code). */
export function parseTokenResponse(provider: ProviderId, raw: Record<string, unknown>, now: number): TokenSet {
  if (provider === 'slack' && raw.ok === false) throw new ConnectorError(`Slack refused the connection: ${String(raw.error)}`, 'Slack', 400, str(raw.error));
  if (provider === 'lark' && typeof raw.code === 'number' && raw.code !== 0) throw new ConnectorError(`Lark refused the connection: ${String(raw.msg ?? raw.error_description ?? raw.code)}`, 'Lark', 400, str(raw.error) ?? String(raw.code));
  const body = (provider === 'lark' && raw.data && typeof raw.data === 'object' ? raw.data : raw) as Record<string, unknown>;
  const accessToken = str(body.access_token);
  if (!accessToken) throw new ConnectorError(`${provider} didn't return an access token`, provider, 400, 'no_token');
  const expiresIn = Number(body.expires_in);
  const extra: Record<string, string> = {};
  for (const k of ['id_token', 'bot_id', 'workspace_id', 'workspace_name', 'bot_user_id', 'app_id', 'open_id', 'tenant_key']) {
    const v = str(body[k]);
    if (v) extra[k] = v;
  }
  const team = body.team as Record<string, unknown> | undefined;
  if (team) { if (str(team.id)) extra.team_id = str(team.id)!; if (str(team.name)) extra.team_name = str(team.name)!; }
  const owner = body.owner as { user?: { id?: string; name?: string; person?: { email?: string } } } | undefined;
  if (owner?.user?.person?.email) extra.owner_email = owner.user.person.email;
  return {
    accessToken,
    ...(str(body.refresh_token) ? { refreshToken: str(body.refresh_token) } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now + expiresIn * 1000 } : {}),
    ...(str(body.scope) ? { scope: str(body.scope) } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}
