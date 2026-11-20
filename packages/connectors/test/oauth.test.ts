import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectorError, jwtClaims, decodeBase64Utf8, encodeBase64Utf8 } from '../src/http.js';
import { loopbackAuthorize } from '../src/node.js';
import { buildAuthorizeUrl, exchangeCode, refreshTokens } from '../src/oauth.js';
import { endpointsAt, oauthApp } from '../src/providers/registry.js';
import { startFakes, type Fake } from '../src/testing/fakes.js';
import { authorizeCode, CLIENTS, http } from './helpers.js';

let fake: Fake;
beforeAll(async () => { fake = await startFakes(); });
afterAll(() => fake.close());

describe('authorize URLs', () => {
  it('ask each app for the right permissions', () => {
    const ep = endpointsAt('https://x.test');
    const g = new URL(buildAuthorizeUrl(oauthApp('google', CLIENTS.google, ep), { redirectUri: 'http://127.0.0.1:1/callback', state: 's', codeChallenge: 'c' }));
    expect(g.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(g.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/tasks');
    expect(g.searchParams.get('access_type')).toBe('offline');
    expect(g.searchParams.get('code_challenge_method')).toBe('S256');
    const s = new URL(buildAuthorizeUrl(oauthApp('slack', CLIENTS.slack, ep), { redirectUri: 'https://bibbly.io/oauth/slack/callback', state: 's' }));
    expect(s.searchParams.get('scope')).toBe('chat:write,chat:write.public,channels:read,groups:read,channels:join,files:write');
    expect(s.searchParams.get('code_challenge')).toBeNull();
    const n = new URL(buildAuthorizeUrl(oauthApp('notion', CLIENTS.notion, ep), { redirectUri: 'https://bibbly.io/oauth/notion/callback', state: 's' }));
    expect(n.searchParams.get('owner')).toBe('user');
    const m = new URL(buildAuthorizeUrl(oauthApp('microsoft', CLIENTS.microsoft, ep), { redirectUri: 'http://127.0.0.1:1/callback', state: 's' }));
    expect(m.searchParams.get('scope')).toContain('offline_access');
    expect(m.searchParams.get('scope')).toContain('Calendars.ReadWrite');
  });
});

describe('sign-in', () => {
  it('completes the desktop loopback flow with PKCE (Google)', async () => {
    const app = oauthApp('google', CLIENTS.google, endpointsAt(fake.url));
    const opened: string[] = [];
    const result = await loopbackAuthorize(app, { open: async url => { opened.push(url); const r = await fetch(url, { redirect: 'manual' }); await fetch(r.headers.get('location')!); } });
    expect(result.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(new URL(opened[0]!).searchParams.get('code_challenge')).toBeTruthy();
    const { tokens } = await exchangeCode(app, result, http());
    expect(tokens.accessToken).toMatch(/^g-at-/);
    expect(tokens.refreshToken).toBe('g-rt');
    expect(jwtClaims(tokens.extra?.id_token).email).toBe('ada@example.com');
    expect(fake.google.tokenRequests.at(-1)).toMatchObject({ client_id: 'g-client', client_secret: 'g-desktop-secret', grant_type: 'authorization_code' });
  });

  it('rejects a wrong PKCE verifier', async () => {
    const app = oauthApp('google', CLIENTS.google, endpointsAt(fake.url));
    const code = await authorizeCode(app);
    await expect(exchangeCode(app, { ...code, codeVerifier: 'not-the-verifier' }, http())).rejects.toMatchObject({ code: 'invalid_pkce' });
  });

  it('signs in Microsoft as a public client (no secret) and refreshes', async () => {
    const app = oauthApp('microsoft', CLIENTS.microsoft, endpointsAt(fake.url));
    const { tokens } = await exchangeCode(app, await authorizeCode(app), http());
    expect(fake.microsoft.tokenRequests.at(-1)!.client_secret).toBeUndefined();
    const fresh = await refreshTokens(app, tokens.refreshToken!, http());
    expect(fresh.accessToken).not.toBe(tokens.accessToken);
    expect(fresh.refreshToken).toBe('m-rt'); // kept when the app doesn't send a new one
    expect(fake.microsoft.tokenRequests.at(-1)!.scope).toContain('offline_access');
  });

  it('reads Slack, Notion and Lark token responses', async () => {
    const ep = endpointsAt(fake.url);
    const slack = oauthApp('slack', CLIENTS.slack, ep);
    const s = await exchangeCode(slack, await authorizeCode(slack), http());
    expect(s.tokens.accessToken).toMatch(/^xoxb-/);
    expect(s.tokens.extra).toMatchObject({ team_id: 'T1', team_name: 'Acme' });
    const noSecret = oauthApp('slack', { clientId: 'slack-client' }, ep);
    await expect(exchangeCode(noSecret, await authorizeCode(noSecret), http())).rejects.toBeInstanceOf(ConnectorError);

    const notion = oauthApp('notion', CLIENTS.notion, ep);
    const n = await exchangeCode(notion, await authorizeCode(notion), http());
    expect(fake.notion.tokenRequests.at(-1)!.authorization).toBe(`Basic ${encodeBase64Utf8('notion-client:notion-secret')}`);
    expect(n.tokens.extra).toMatchObject({ workspace_name: 'Acme HQ', workspace_id: 'ws-1' });
    expect(n.tokens.expiresAt).toBeUndefined();

    const lark = oauthApp('lark', CLIENTS.lark, ep);
    const l = await exchangeCode(lark, await authorizeCode(lark), http());
    expect(l.tokens).toMatchObject({ refreshToken: 'l-rt' });
    expect(fake.lark.tokenRequests.at(-1)).toMatchObject({ client_id: 'cli_lark', client_secret: 'lark-secret', grant_type: 'authorization_code' });
    await expect(refreshTokens(lark, 'bad', http())).rejects.toThrow(/Lark refused/);
  });

  it('decodes UTF-8 base64 without atob', () => {
    expect(decodeBase64Utf8(encodeBase64Utf8('林 · café 🙂'))).toBe('林 · café 🙂');
  });
});
