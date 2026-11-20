# CLAUDE.md

Guidance for Claude Code (and people) working in this repository.

## What Bibbly is

Live captions in each reader's own language (with per-speaker language
detection, including mixed-language speech), Clarity meeting notes, tasks,
reminders and a calendar, connected apps (Google, Microsoft 365, Slack, Notion,
Lark), and the Bibbly Stick, a USB-C microphone and pocket recorder.
`apps/web/public/index.html` is the interactive prototype everything follows.

## Layout

| Path | What |
|---|---|
| `packages/core` | Shared engine: languages, audio, speech providers, Claude translation and notes, sessions, rooms protocol, exports, Stick protocol. Platform-neutral TypeScript. |
| `packages/connectors` | Connected apps: OAuth, provider clients, two-way task and calendar sync, sending notes. Platform-neutral except `src/node.ts` (desktop sign-in) and `src/testing/` (fake provider servers). |
| `apps/server` | Rooms relay and the OAuth sign-in broker (`src/oauth-broker.ts`). |
| `apps/desktop` | Electron app. Main process in `electron/` (sessions, Stick, `connectors.ts`), React UI in `src/`. |
| `apps/mobile` | Expo app (separate `npm install`). Connected apps in `src/connectors.ts` and `src/ui/apps.tsx`. |
| `apps/web` | The prototype as a static site, published by `.github/workflows/pages.yml`. |
| `firmware/bibbly-stick` | ESP32-S3 firmware. Device logic in `components/stick_core` (portable C, host-tested). |
| `docs/` | `connectors.md` (connected-app setup), `stick-protocol.md`. |
| `prompts/` | Every request that shaped the project, verbatim. |

## Commands

```bash
npm install                 # root workspaces (core, connectors, server, desktop)
npm run build:libs          # core + connectors; run after changing either (others import their dist/)
npm run typecheck
npm test                    # core, connectors, server
npm run build
npm run e2e -w @bibbly/desktop                                   # Electron under Xvfb, against fake providers
cd apps/mobile && npm install && npm run typecheck && npm run bundle && npm run e2e
npm run firmware:test       # firmware host tests + simulator
```

`.vscode/tasks.json` and `launch.json` wrap these.

## Conventions

- TypeScript strict, ESM. Match the surrounding code's style; keep changes focused.
- `packages/core` and `packages/connectors` (outside `node.ts` and `testing/`) must not use Node or DOM-only APIs: they run in React Native too. `npm run typecheck -w @bibbly/connectors` checks this.
- Tests go next to the code they cover. Connector and broker tests run against `@bibbly/connectors/testing` (fake Google, Graph, Slack, Notion and Lark servers that apply the real APIs' rules). Extend the fakes when you use a new endpoint.
- Every task and event change stamps `updatedAt`; sync relies on it.
- Don't put model identifiers in commits, PR text or code comments.

## Security

- Never log tokens, codes or secrets. Desktop keeps sign-ins and API keys in the OS keychain (Electron `safeStorage`); mobile in SecureStore; the server holds client secrets only in its environment (`apps/server/.env.example`).
- Client secrets never ship in an app. Only public desktop client ids (Google desktop, Microsoft public client) may be embedded at build time.
- The broker releases tokens once, to the device holding the sign-in secret and the completion code; keep both checks.

## Prompts log

For every new request, add `prompts/YYYY-MM-DD-NN-short-title.md` with the
request verbatim in a ` ```text ` block, plus a row in `prompts/README.md`, and
commit it with the code it produced.
