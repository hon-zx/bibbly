import { Connectors } from '../src/sync/engine.js';
import { exchangeCode, refreshTokens, type OAuthApp } from '../src/oauth.js';
import { Http } from '../src/http.js';
import { pkcePair } from '../src/node.js';
import { buildAuthorizeUrl } from '../src/oauth.js';
import { endpointsAt, oauthApp, type ClientConfig, type Endpoints } from '../src/providers/registry.js';
import { emptyConnectorState, type ConnectedAccount, type ConnectorState, type ProviderId, type TokenSet } from '../src/types.js';
import type { Fake } from '../src/testing/fakes.js';

export const CLIENTS: Record<ProviderId, ClientConfig> = {
  google: { clientId: 'g-client', clientSecret: 'g-desktop-secret' },
  microsoft: { clientId: 'ms-client' },
  slack: { clientId: 'slack-client', clientSecret: 'slack-secret' },
  notion: { clientId: 'notion-client', clientSecret: 'notion-secret' },
  lark: { clientId: 'cli_lark', clientSecret: 'lark-secret' },
};

export const http = (name = 'test') => new Http(name, { sleep: async () => {} });

/** Runs the consent step against the fake (no browser) and returns the code. */
export async function authorizeCode(app: OAuthApp, redirectUri = 'http://127.0.0.1:7777/callback') {
  const pkce = app.pkce ? pkcePair() : null;
  const url = buildAuthorizeUrl(app, { redirectUri, state: 'st', ...(pkce ? { codeChallenge: pkce.challenge } : {}) });
  const res = await fetch(url, { redirect: 'manual' });
  const loc = new URL(res.headers.get('location')!);
  return { code: loc.searchParams.get('code')!, redirectUri, ...(pkce ? { codeVerifier: pkce.verifier } : {}) };
}

export class MemoryTokens {
  map = new Map<string, TokenSet>();
  async get(id: string) { return this.map.get(id) ?? null; }
  async set(id: string, t: TokenSet | null) { if (t) this.map.set(id, t); else this.map.delete(id); }
}

export interface Harness {
  ep: Endpoints;
  tokens: MemoryTokens;
  connectors: Connectors;
  state: ConnectorState;
  connect(provider: ProviderId): Promise<ConnectedAccount>;
}

export function harness(fake: Fake, now = () => fake.clock.now): Harness {
  const ep = endpointsAt(fake.url);
  const tokens = new MemoryTokens();
  const connectors = new Connectors({
    tokens, endpoints: ep, now, sleep: async () => {},
    refresh: (account, rt) => refreshTokens(oauthApp(account.provider, CLIENTS[account.provider], ep), rt, http()),
  });
  const h: Harness = {
    ep, tokens, connectors, state: emptyConnectorState(),
    async connect(provider) {
      const app = oauthApp(provider, CLIENTS[provider], ep);
      const code = await authorizeCode(app);
      const { tokens: t } = await exchangeCode(app, code, http(), now());
      const r = await connectors.addAccount(h.state, provider, provider === 'google' || provider === 'microsoft' ? 'loopback' : 'broker', t);
      h.state = r.state;
      return r.account;
    },
  };
  return h;
}
