/** The connected apps Bibbly supports, their endpoints and default permissions. */
import type { OAuthApp } from '../oauth.js';
import type { Capability, ProviderId } from '../types.js';

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  capabilities: Capability[];
  /** What each capability is called in that app, for Settings. */
  labels: Partial<Record<Capability, string>>;
  /** Set when the user can paste a token instead of signing in. */
  tokenHint?: string;
  /** Not yet tested against a live tenant. */
  beta?: boolean;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  google: { id: 'google', name: 'Google', capabilities: ['calendar', 'tasks', 'notes'], labels: { calendar: 'Google Calendar', tasks: 'Google Tasks', notes: 'Google Docs in Drive' } },
  microsoft: { id: 'microsoft', name: 'Microsoft 365', capabilities: ['calendar', 'tasks', 'notes'], labels: { calendar: 'Outlook Calendar', tasks: 'Microsoft To Do', notes: 'Microsoft Teams channel' } },
  slack: { id: 'slack', name: 'Slack', capabilities: ['notes'], labels: { notes: 'Slack channel' }, tokenHint: 'Bot token from your Slack app (starts with xoxb-)' },
  notion: { id: 'notion', name: 'Notion', capabilities: ['notes'], labels: { notes: 'Notion page' }, tokenHint: 'Internal integration secret (starts with ntn_ or secret_)' },
  lark: { id: 'lark', name: 'Lark', capabilities: ['calendar', 'tasks', 'notes'], labels: { calendar: 'Lark Calendar', tasks: 'Lark Tasks', notes: 'Lark chat' }, beta: true },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

/** Every URL Bibbly calls, so tests and self-hosted setups can point elsewhere. */
export interface Endpoints {
  googleAuthorize: string;
  googleToken: string;
  googleRevoke: string;
  googleUserinfo: string;
  googleCalendar: string;
  googleTasks: string;
  googleDrive: string;
  googleDriveUpload: string;
  microsoftLogin: string;
  graph: string;
  slackAuthorize: string;
  slackApi: string;
  notionApi: string;
  larkAccounts: string;
  larkApi: string;
}

export function defaultEndpoints(opts: { microsoftTenant?: string; larkRegion?: 'lark' | 'feishu' } = {}): Endpoints {
  const feishu = opts.larkRegion === 'feishu';
  return {
    googleAuthorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    googleToken: 'https://oauth2.googleapis.com/token',
    googleRevoke: 'https://oauth2.googleapis.com/revoke',
    googleUserinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
    googleCalendar: 'https://www.googleapis.com/calendar/v3',
    googleTasks: 'https://tasks.googleapis.com/tasks/v1',
    googleDrive: 'https://www.googleapis.com/drive/v3',
    googleDriveUpload: 'https://www.googleapis.com/upload/drive/v3',
    microsoftLogin: `https://login.microsoftonline.com/${opts.microsoftTenant ?? 'common'}/oauth2/v2.0`,
    graph: 'https://graph.microsoft.com/v1.0',
    slackAuthorize: 'https://slack.com/oauth/v2/authorize',
    slackApi: 'https://slack.com/api',
    notionApi: 'https://api.notion.com/v1',
    larkAccounts: feishu ? 'https://accounts.feishu.cn/open-apis' : 'https://accounts.larksuite.com/open-apis',
    larkApi: feishu ? 'https://open.feishu.cn/open-apis' : 'https://open.larksuite.com/open-apis',
  };
}

/** Points every endpoint at one base URL (used by the fake providers in tests). */
export function endpointsAt(base: string): Endpoints {
  const b = base.replace(/\/$/, '');
  return {
    googleAuthorize: `${b}/google/oauth/authorize`, googleToken: `${b}/google/oauth/token`, googleRevoke: `${b}/google/oauth/revoke`,
    googleUserinfo: `${b}/google/userinfo`, googleCalendar: `${b}/google/calendar/v3`, googleTasks: `${b}/google/tasks/v1`,
    googleDrive: `${b}/google/drive/v3`, googleDriveUpload: `${b}/google/upload/drive/v3`,
    microsoftLogin: `${b}/microsoft/oauth`, graph: `${b}/graph/v1.0`,
    slackAuthorize: `${b}/slack/oauth/authorize`, slackApi: `${b}/slack/api`,
    notionApi: `${b}/notion/v1`, larkAccounts: `${b}/lark/accounts`, larkApi: `${b}/lark/open-apis`,
  };
}

export interface ClientConfig {
  clientId: string;
  clientSecret?: string;
  /** Replaces the default permissions. */
  scopes?: string[];
}

export const DEFAULT_SCOPES: Record<ProviderId, string[]> = {
  google: [
    'openid', 'email', 'profile',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/tasks',
    'https://www.googleapis.com/auth/drive.file',
  ],
  // Teams scopes need a work or school account; personal accounts drop the last three.
  microsoft: ['offline_access', 'openid', 'email', 'profile', 'User.Read', 'Calendars.ReadWrite', 'Tasks.ReadWrite', 'Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Send'],
  slack: ['chat:write', 'chat:write.public', 'channels:read', 'groups:read', 'channels:join', 'files:write'],
  notion: [],
  lark: ['offline_access', 'calendar:calendar', 'task:task:write', 'task:tasklist:write', 'im:chat:readonly', 'im:message', 'im:message.send_as_user'],
};

/** The OAuth settings for a provider and client registration. */
export function oauthApp(provider: ProviderId, cfg: ClientConfig, ep: Endpoints = defaultEndpoints()): OAuthApp {
  const scopes = cfg.scopes ?? DEFAULT_SCOPES[provider];
  const base = { provider, clientId: cfg.clientId, ...(cfg.clientSecret ? { clientSecret: cfg.clientSecret } : {}), scopes };
  switch (provider) {
    case 'google':
      return { ...base, authorizeUrl: ep.googleAuthorize, tokenUrl: ep.googleToken, tokenAuth: 'body', tokenFormat: 'form', pkce: true,
               extraAuthorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' } };
    case 'microsoft':
      return { ...base, authorizeUrl: `${ep.microsoftLogin}/authorize`, tokenUrl: `${ep.microsoftLogin}/token`, tokenAuth: 'body', tokenFormat: 'form', pkce: true,
               extraAuthorizeParams: { prompt: 'select_account' } };
    case 'slack':
      return { ...base, authorizeUrl: ep.slackAuthorize, tokenUrl: `${ep.slackApi}/oauth.v2.access`, scopeSeparator: ',', tokenAuth: 'body', tokenFormat: 'form', pkce: false };
    case 'notion':
      return { ...base, authorizeUrl: `${ep.notionApi}/oauth/authorize`, tokenUrl: `${ep.notionApi}/oauth/token`, tokenAuth: 'basic', tokenFormat: 'json', pkce: false,
               extraAuthorizeParams: { owner: 'user' } };
    case 'lark':
      return { ...base, authorizeUrl: `${ep.larkAccounts}/authen/v1/authorize`, tokenUrl: `${ep.larkApi}/authen/v2/oauth/token`, tokenAuth: 'body', tokenFormat: 'json', pkce: false,
               extraAuthorizeParams: { app_id: cfg.clientId } };
  }
}
