# Connected apps

Bibbly syncs tasks and calendars both ways with Google and Microsoft 365 (and
Lark), and sends meeting notes to Google Docs, Microsoft Teams, Slack, Notion
and Lark. The code is in `packages/connectors`; the desktop app runs it in its
main process (`apps/desktop/electron/connectors.ts`), the phone app in
`apps/mobile/src/connectors.ts`, and `apps/server` brokers sign-ins.

| App | Calendar | Tasks | Notes go to |
|---|---|---|---|
| Google | Google Calendar | Google Tasks | A Google Doc in a “Bibbly notes” folder in Drive |
| Microsoft 365 | Outlook Calendar | Microsoft To Do | A Teams channel |
| Slack | | | A channel: summary, decisions and action items, with the full transcript attached in the thread |
| Notion | | | A new page under a page you pick, with the full transcript |
| Lark (beta) | Lark Calendar | Lark Tasks | A group chat |

## How sign-in works

Client secrets never ship inside an app.

- **Desktop, Google and Microsoft:** the app signs in straight from the computer (system browser, PKCE, a one-off `http://127.0.0.1:<port>/callback` listener) when it's built with desktop client ids. Otherwise it goes through the broker, like the other apps.
- **Desktop, Slack, Notion and Lark,** and **every app on the phone:** sign-in goes through the Bibbly server's broker, which holds the client secrets. The phone opens the system browser and comes back to `bibbly://oauth`; the desktop app comes back to a loopback address.
- **Slack and Notion** also accept a pasted token (a Slack bot token or a Notion internal integration secret), so no server is needed for them.

The broker hands the tokens to the device once, and only to a device that has
both the secret it received when it started the sign-in and the completion
code that the browser brings back. A sign-in link forwarded to someone else is
useless to whoever sent it, and an app that intercepts `bibbly://oauth` can't
collect the tokens. App redirects other than `bibbly://…` and loopback
addresses are refused. Tokens stay in the server's memory only until they're
collected (10 minutes at most) and are never logged. The server also refreshes
access tokens on request, adding the client secret.

On the device, tokens are kept in the OS keychain (Electron `safeStorage` on
desktop; on Linux without a keyring this falls back to obfuscation, and
Settings says so) or the phone's keychain (SecureStore). Disconnecting asks
Google and Slack to revoke Bibbly's access, then deletes the tokens.

## What syncs, and how

Sync runs a few seconds after you change a task or event, every 5 minutes, when
the computer wakes or the phone app comes back to the foreground, and from
**Sync now** in Settings.

**Tasks** sync both ways with a list called “Bibbly” in Google Tasks, Microsoft
To Do or Lark Tasks (created on first sync). Edits on either side carry over;
if both sides changed, the later edit wins. Deleting on one side deletes on the
other, unless the other side was edited afterwards. A task that already exists
in both places (same title and day) is paired, not duplicated. Tasks finished
before you connected stay in Bibbly, and Bibbly's example and welcome tasks
never leave the device. Google Tasks and To Do store due dates without a time;
Bibbly keeps your time as long as the day matches.

**Calendar:** meetings from yesterday to 30 days ahead appear in Bibbly's
calendar, with their Meet, Teams, Zoom or Lark link, and follow the connected
calendar when they move or are cancelled. Their title and time belong to that
calendar; Bibbly's own details (whether Bibbly joins, the languages) stay in
Bibbly. Follow-ups you create in Bibbly are saved to the one calendar with
**Save follow-ups here** on, with a Google Meet, Teams or Lark meeting link
added. A meeting that already has Bibbly notes stays in Bibbly if it's
cancelled.

**Notes:** send any note from **Notes → Export & share → Send to a connected
app**, or turn on **Send every note when a meeting ends** for an account.

## Setting up each app

The server needs a public HTTPS address (`BIBBLY_PUBLIC_URL`) for the
providers' redirects; each provider's redirect URI is
`<BIBBLY_PUBLIC_URL>/oauth/<provider>/callback`. Copy
`apps/server/.env.example` to `apps/server/.env` and fill in what you use. In
both apps, put the server's address in **Settings → Bibbly server**.

### Google (Google Cloud console)

1. Create a project and enable the **Google Calendar API**, **Google Tasks API** and **Google Drive API**.
2. **OAuth consent screen**: add the scopes `openid`, `email`, `profile`, `…/auth/calendar.events`, `…/auth/tasks` and `…/auth/drive.file`. Calendar and Tasks are sensitive scopes: while the app is in testing, add test users; publishing to everyone needs Google's verification.
3. **Credentials → Create OAuth client ID**:
   - **Web application** (for the broker): authorized redirect URI `<BIBBLY_PUBLIC_URL>/oauth/google/callback`. Set `BIBBLY_GOOGLE_CLIENT_ID` and `BIBBLY_GOOGLE_CLIENT_SECRET` on the server.
   - **Desktop app** (optional, for signing in straight from the desktop app): build the desktop app with `BIBBLY_GOOGLE_DESKTOP_CLIENT_ID` and `BIBBLY_GOOGLE_DESKTOP_CLIENT_SECRET` set. Google treats a desktop client's secret as public, and loopback redirects need no registration.

### Microsoft 365 (Microsoft Entra admin center → App registrations)

1. **New registration**, supported accounts: any organizational directory and personal Microsoft accounts.
2. **API permissions → Microsoft Graph → Delegated**: `offline_access`, `openid`, `email`, `profile`, `User.Read`, `Calendars.ReadWrite`, `Tasks.ReadWrite`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Send`. The Teams permissions only work for work or school accounts, and some organizations require an admin to consent.
3. **Authentication**:
   - **Web** platform (for the broker): redirect URI `<BIBBLY_PUBLIC_URL>/oauth/microsoft/callback`. Under **Certificates & secrets**, create a client secret. Set `BIBBLY_MICROSOFT_CLIENT_ID`, `BIBBLY_MICROSOFT_CLIENT_SECRET` and, for a single organization, `BIBBLY_MICROSOFT_TENANT`.
   - **Mobile and desktop applications** platform (optional, for signing in straight from the desktop app): redirect URI `http://127.0.0.1/callback`. Microsoft ignores the port on loopback addresses; if the portal won't accept `127.0.0.1`, add it to `replyUrlsWithType` in the app's **Manifest**. Build the desktop app with `BIBBLY_MICROSOFT_CLIENT_ID` set (no secret).

### Slack (api.slack.com/apps)

1. **Create New App → From scratch.**
2. **OAuth & Permissions → Bot Token Scopes**: `chat:write`, `chat:write.public`, `channels:read`, `groups:read`, `channels:join`, `files:write`.
3. **Redirect URLs**: `<BIBBLY_PUBLIC_URL>/oauth/slack/callback` (Slack requires HTTPS; for local testing use a tunnel, or the token option below).
4. Set `BIBBLY_SLACK_CLIENT_ID` and `BIBBLY_SLACK_CLIENT_SECRET` from **Basic Information**.

Without the server: **Install to Workspace**, copy the **Bot User OAuth Token** (`xoxb-…`) and paste it in **Settings → Slack → Token**. Bibbly joins public channels by itself; invite it to private channels with `/invite @YourApp`.

### Notion (notion.so/profile/integrations)

- **Public integration** (sign-in through the broker): redirect URI `<BIBBLY_PUBLIC_URL>/oauth/notion/callback`, capabilities **Read content** and **Insert content**. Set `BIBBLY_NOTION_CLIENT_ID` and `BIBBLY_NOTION_CLIENT_SECRET`. During sign-in, people choose which pages Bibbly may use.
- **Internal integration** (no server): copy its secret (`ntn_…`) into **Settings → Notion → Token**, then open the page notes should go under and add the integration under **Connections**.

Bibbly uses Notion API version `2026-03-11` and creates one page per note, with long transcripts appended 100 blocks at a time.

### Lark or Feishu (developer console), beta

1. Create a custom app. Under **Security settings**, add the redirect URL `<BIBBLY_PUBLIC_URL>/oauth/lark/callback`.
2. Request the permissions `calendar:calendar`, `task:task:write`, `task:tasklist:write`, `im:chat:readonly`, `im:message`, `im:message.send_as_user` and `offline_access`, then publish a version of the app.
3. Set `BIBBLY_LARK_APP_ID` and `BIBBLY_LARK_APP_SECRET`, plus `BIBBLY_LARK_REGION=feishu` for Feishu (China).

Lark is marked beta: it follows Lark's published API and passes the tests against the fake Lark server, but hasn't been run against a live tenant yet.

## Running the server

```bash
cp apps/server/.env.example apps/server/.env   # then fill it in
npm run build:libs && npm run build -w @bibbly/server
node --env-file=apps/server/.env apps/server/dist/index.js
```

It prints which apps it can connect and the redirect URI pattern.
`GET /oauth/providers` lists them for the apps. Run it behind HTTPS (any host
with a TLS-terminating proxy works), set `BIBBLY_TRUST_PROXY=1` there, and
point `BIBBLY_PUBLIC_URL` at its HTTPS address.

## Testing without real accounts

`npm test` runs the connector and broker tests against fake Google, Microsoft
Graph, Slack, Notion and Lark servers (`@bibbly/connectors/testing`), which
apply the real APIs' rules: PKCE and redirect checks, Google Tasks' date-only
due dates, Graph's UTC and paging, Slack's two-step file upload, Notion's
block and text limits, Lark's wrapped responses. The desktop end-to-end test
(`npm run e2e -w @bibbly/desktop`) and the phone preview test
(`cd apps/mobile && npm run e2e`) connect Google and Slack in the real apps
against the same fakes.

Set `BIBBLY_PROVIDER_BASE_URL` (server and desktop) or
`EXPO_PUBLIC_BIBBLY_PROVIDER_BASE_URL` (phone, at build time) to send every
provider call to one base URL, as the tests do.

## Not done yet

- Sync runs while a Bibbly app is open; there is no server-side background sync or push from the providers yet.
- Recurring meetings come in as individual occurrences, and only the next 30 days.
- Bibbly doesn't join Zoom, Meet or Teams calls as a bot; Zoom links in your calendar are recognised, but there's no Zoom calendar to connect.
- Lark needs testing against a live tenant.
