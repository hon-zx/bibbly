import { BrokerClient, ConnectorError, completionCode, endpointsAt } from '@bibbly/connectors';
import { brokerAuthorize } from '@bibbly/connectors/node';
import { startFakes, type Fake } from '@bibbly/connectors/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowedAppRedirect, brokerOptionsFromEnv } from '../src/oauth-broker.js';
import { startServer, type RunningServer } from '../src/server.js';

const clock = { now: Date.UTC(2026, 10, 19, 9, 0, 0) };
let fake: Fake;
let server: RunningServer;
let base: string;
let broker: BrokerClient;

beforeAll(async () => {
  fake = await startFakes();
  server = await startServer({
    port: 0, host: '127.0.0.1', translator: null,
    oauth: {
      clients: {
        google: { clientId: 'g-web', clientSecret: 'g-web-secret' },
        slack: { clientId: 'slack-client', clientSecret: 'slack-secret' },
        notion: { clientId: 'notion-client', clientSecret: 'notion-secret' },
        lark: { clientId: 'cli_lark', clientSecret: 'lark-secret' },
        microsoft: { clientId: 'ms-web' }, // no secret: not offered
      },
      endpoints: endpointsAt(fake.url), now: () => clock.now, rateLimit: { start: 15 },
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  broker = new BrokerClient(base);
});
afterAll(async () => { await server.close(); await fake.close(); });

/** Plays the user's browser: follows redirects from the consent page and returns where it ends up. */
async function browse(url: string): Promise<string> {
  let at = url;
  for (let i = 0; i < 6 && /^https?:/.test(at); i++) {
    const res = await fetch(at, { redirect: 'manual' });
    const loc = res.headers.get('location');
    if (!loc) break;
    at = new URL(loc, at).toString();
  }
  return at;
}

const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e: ConnectorError) => e);

describe('OAuth broker', () => {
  it('lists the apps it can connect', async () => {
    expect(await broker.providers()).toEqual([
      { id: 'google', name: 'Google', configured: true },
      { id: 'microsoft', name: 'Microsoft 365', configured: false },
      { id: 'slack', name: 'Slack', configured: true },
      { id: 'notion', name: 'Notion', configured: true },
      { id: 'lark', name: 'Lark', configured: true, beta: true },
    ]);
    const health = (await fetch(`${base}/healthz`).then(r => r.json())) as { connectors: string[] };
    expect(health.connectors).toEqual(['google', 'slack', 'notion', 'lark']);
    expect((await failure(broker.start('microsoft', 'bibbly://oauth'))).code).toBe('not_configured');
  });

  it('phone sign-in: the browser returns to bibbly://oauth and the app collects the tokens once', async () => {
    const s = await broker.start('google', 'bibbly://oauth');
    const authorize = new URL(s.authorizeUrl);
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${base}/oauth/google/callback`);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('client_id')).toBe('g-web');

    const landed = await browse(s.authorizeUrl);
    expect(landed).toMatch(/^bibbly:\/\/oauth\?session=/);
    const tokens = await broker.collect(s, completionCode(landed, s));
    expect(tokens).toMatchObject({ refreshToken: 'g-rt' });
    expect(tokens.accessToken).toMatch(/^g-at-/);
    // The server added its client secret and the PKCE verifier; neither is on the phone.
    expect(fake.google.tokenRequests.at(-1)).toMatchObject({ client_secret: 'g-web-secret', redirect_uri: `${base}/oauth/google/callback` });
    expect(fake.google.tokenRequests.at(-1)!.code_verifier).toBeTruthy();
    // Collecting works once.
    expect((await failure(broker.collect(s, completionCode(landed, s)))).status).toBe(404);
    expect(server.broker!.pending).toBe(0);
  });

  it('needs both the device secret and the completion code', async () => {
    const s = await broker.start('google', 'bibbly://oauth');
    const landed = await browse(s.authorizeUrl);
    const code = completionCode(landed, s);
    // Someone who only has the session id (say, an app that grabbed the redirect) can't collect.
    expect((await failure(broker.collect({ ...s, secret: 'guess' }, code))).status).toBe(403);
    // A sign-in link forwarded to someone else: the sender has the secret but never sees the code.
    expect((await failure(broker.collect(s, 'guess'))).status).toBe(403);
    expect((await broker.collect(s, code)).accessToken).toMatch(/^g-at-/);
  });

  it('desktop sign-in through a loopback address (Slack, Notion, Lark)', async () => {
    const slack = await brokerAuthorize(broker, 'slack', { open: browse });
    expect(slack.accessToken).toMatch(/^xoxb-/);
    expect(slack.extra).toMatchObject({ team_name: 'Acme' });
    expect(fake.slack.tokenRequests.at(-1)).toMatchObject({ client_secret: 'slack-secret' });
    const notion = await brokerAuthorize(broker, 'notion', { open: browse });
    expect(notion.accessToken).toMatch(/^ntn-/);
    expect(fake.notion.tokenRequests.at(-1)!.authorization).toMatch(/^Basic /);
    const lark = await brokerAuthorize(broker, 'lark', { open: browse });
    expect(lark).toMatchObject({ refreshToken: 'l-rt' });
  });

  it('reports a cancelled sign-in back to the app', async () => {
    const s = await broker.start('google', 'bibbly://oauth');
    const state = new URL(s.authorizeUrl).searchParams.get('state')!;
    const landed = await browse(`${base}/oauth/google/callback?state=${state}&error=access_denied`);
    expect(landed).toContain('error=access_denied');
    expect(() => completionCode(landed, s)).toThrow('Sign-in was cancelled.');
    expect(server.broker!.pending).toBe(0);
  });

  it('only returns to the Bibbly app or this computer', async () => {
    for (const bad of ['https://evil.example/steal', 'http://192.168.1.5:8080/cb', 'javascript:alert(1)', 'http://127.0.0.1/no-port', 'http://localhost.evil.example:80/'])
      expect(allowedAppRedirect(bad), bad).toBeNull();
    expect(allowedAppRedirect('bibbly://oauth')).toBe('bibbly://oauth');
    expect(allowedAppRedirect('http://127.0.0.1:53123/callback')).toBeTruthy();
    expect((await failure(broker.start('google', 'https://evil.example/steal'))).code).toBe('bad_redirect');
  });

  it('expires sign-ins that take too long', async () => {
    const s = await broker.start('google', 'bibbly://oauth');
    clock.now += 11 * 60_000;
    const landed = await browse(s.authorizeUrl);
    expect(landed).toContain('/oauth/google/callback'); // stopped at the "link expired" page
    const page = await fetch(landed);
    expect(page.status).toBe(400);
    expect(await page.text()).toContain('This sign-in link has expired');
  });

  it('refreshes access tokens with the server-held secret', async () => {
    const before = fake.google.refreshes;
    const t = await broker.refresh('google', 'g-rt');
    expect(t.accessToken).toMatch(/^g-at-/);
    expect(t.refreshToken).toBe('g-rt'); // kept when the provider doesn't send a new one
    expect(fake.google.refreshes).toBe(before + 1);
    const err = await failure(broker.refresh('google', 'revoked'));
    expect(err.code).toBe('invalid_grant');
    expect(err.needsReconnect).toBe(true);
  });

  it('never lets responses be cached, and limits sign-in starts per address', async () => {
    const res = await fetch(`${base}/oauth/providers`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    let limited: ConnectorError | null = null;
    for (let i = 0; i < 20 && !limited; i++) {
      try { await broker.start('notion', 'bibbly://oauth'); } catch (e) { limited = e as ConnectorError; }
    }
    expect(limited?.status).toBe(429);
  });

  it('reads its settings from the environment', () => {
    const o = brokerOptionsFromEnv({
      BIBBLY_PUBLIC_URL: 'https://bibbly.example.com', BIBBLY_GOOGLE_CLIENT_ID: 'id', BIBBLY_GOOGLE_CLIENT_SECRET: 'secret',
      BIBBLY_LARK_APP_ID: 'cli_x', BIBBLY_LARK_APP_SECRET: 's', BIBBLY_LARK_REGION: 'feishu', BIBBLY_MICROSOFT_TENANT: 'contoso.onmicrosoft.com',
    });
    expect(o.publicUrl).toBe('https://bibbly.example.com');
    expect(Object.keys(o.clients)).toEqual(['google', 'lark']);
    expect(o.endpoints!.larkApi).toBe('https://open.feishu.cn/open-apis');
    expect(o.endpoints!.microsoftLogin).toBe('https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0');
  });
});
