# Bibbly

Live multilingual captions, meeting notes, tasks and the Bibbly Stick.

Bibbly listens to a conversation, works out which language each person is speaking (including people who mix languages mid-sentence), and shows every line in each reader's own language. When the meeting ends you get Clarity notes: summary, decisions, action items and a follow-up. Action items become tasks with reminders, and notes export to Word, Markdown, text and subtitles. Connected apps keep tasks and your calendar in sync both ways with Google and Microsoft 365 (and Lark), and send notes straight to Google Docs, Teams, Slack, Notion or Lark. The Bibbly Stick is a USB-C microphone that also records on its own and syncs later.

## What's here

| Path | What | Status |
|---|---|---|
| `packages/core` | Shared TypeScript engine: languages and detection, audio (resampling, voice activity, ADPCM, WAV), speech providers (Whisper-compatible, Azure, scripted demo), Claude translation and notes, live sessions, rooms protocol, exports, Stick protocol and client | 40 tests |
| `packages/connectors` | Connected apps: OAuth (PKCE, loopback, broker), clients for Google Calendar/Tasks/Drive, Microsoft Graph (Outlook, To Do, Teams), Slack, Notion and Lark; two-way task and calendar sync; sending notes; fake provider servers for tests | 26 tests |
| `apps/desktop` | Electron app for Windows, macOS and Linux: live captions from the mic and meeting audio, a "captions for" switcher per language, Clarity notes, exports, tasks and calendar, connected apps, Stick sync over USB, mini caption window | Type-checked, built; end-to-end test passes (including Google sync and sending to Slack) |
| `apps/server` | Rooms server (share live captions by link or QR code, translated once per listener language) and the sign-in broker for connected apps | 13 tests |
| `apps/mobile` | Expo app for iOS and Android: live captions, join a room in your language, notes, tasks with reminders, connected apps, Stick sync over Bluetooth LE; native microphone module in Swift and Kotlin | Type-checked; Android and iOS bundles build; UI check passes (including Google sync and sending to Slack) |
| `apps/web` | The interactive prototype as a static site, published to GitHub Pages | |
| `firmware/bibbly-stick` | ESP32-S3 firmware: USB microphone + HID + WebUSB sync, encrypted microSD recorder, eyes and ring lights, Bluetooth LE, battery and sleep | Core logic: 507 checks + simulator; platform code checked against ESP-IDF headers (see below) |
| `docs/connectors.md` | Setting up connected apps: each provider's console, redirect URIs, permissions, server settings | |
| `docs/stick-protocol.md` | The Stick's link protocol | |
| `prompts/` | Every request that shaped the project, word for word | |

## Quick start

Needs Node 22.

```bash
npm install
npm run build
npm test
```

### Desktop

```bash
npm run firmware:test                 # optional: builds the Stick simulator for the Stick page
cd apps/desktop && npm start
```

Try **Play the demo meeting** on the Live page. It works offline, with no keys. For real meetings, open Settings:

- **Speech engine**: Azure Speech (continuous language ID) or any Whisper-compatible server, such as OpenAI, Groq or your own faster-whisper.
- **Claude API key** for translation and notes. It is stored encrypted with the OS keychain (Electron `safeStorage`); `ANTHROPIC_API_KEY` also works. The model defaults to `claude-opus-5-5`.

Installers: `npm run package:linux` (or `:mac`, `:win`) in `apps/desktop`, or push a `v*` tag to run `.github/workflows/release-desktop.yml`.

### Bibbly server (rooms and connected apps)

```bash
cp apps/server/.env.example apps/server/.env    # optional: Claude key, connected-app client ids
node --env-file-if-exists=apps/server/.env apps/server/dist/index.js        # PORT=8787 by default
```

In the desktop app, turn on **Share live captions** before starting, and guests join from a browser (`/join/<code>`) or the phone app. Without a Claude key, listeners still get captions in the original language.

### Connected apps

Open **Settings → Connected apps** in either app and connect Google, Microsoft 365, Slack, Notion or Lark. Sign-in goes through the Bibbly server, which holds each provider's client secret (the desktop app can also sign in to Google and Microsoft directly). Slack and Notion also take a pasted token. `docs/connectors.md` covers setting up each provider and what syncs.

### Mobile

See `apps/mobile/README.md`. You need a development build (`npx expo run:ios` / `run:android`, or EAS) for the microphone and Bluetooth.

### Stick firmware

See `firmware/bibbly-stick/README.md`. `npm run firmware:test` builds and tests the device logic on your computer. Flashing a real Stick needs ESP-IDF v5.5 and the TinyUSB submodule.

## Checks

| Command | Covers |
|---|---|
| `npm test` | core (including TypeScript ↔ firmware tests against `stick-sim`), connectors (against fake Google, Microsoft, Slack, Notion and Lark servers) and server |
| `npm run typecheck` | all workspaces |
| `npm run firmware:test` | firmware unit tests and simulator smoke test |
| `npm run e2e -w @bibbly/desktop` | Electron app under Xvfb: demo meeting, language switch, save, export, tasks, Stick import, connecting Google and Slack, task and calendar sync, sending a note |
| `cd apps/mobile && npm run typecheck && npm run bundle && npm run e2e` | mobile types, native bundles, phone-size UI check including connected apps |

`.github/workflows/ci.yml` runs all of these on every push, `firmware.yml` builds the ESP32-S3 image, and `pages.yml` publishes the website.

## Working in VS Code

Open the repository folder and accept the recommended extensions (Claude Code, Vitest, Expo, CMake, ESP-IDF). **Terminal → Run Task** has build, test, type-check, server, desktop, phone and firmware tasks; **Run and Debug** starts the server or the desktop app with breakpoints, or the current test file. `CLAUDE.md` tells Claude Code how the project fits together, and asks it to log each new request in `prompts/`.

## Website

`apps/web/public` is the interactive prototype. `.github/workflows/pages.yml` publishes it to GitHub Pages; `apps/web/README.md` explains pointing a domain such as bibbly.io at it.

## Privacy

Notes, tasks and recordings stay on the device. Audio goes only to the speech engine you choose, text only to Claude, and tasks, calendar events and notes only to the apps you connect. API keys and sign-ins are kept in the OS keychain (desktop) or the iOS/Android keychain (mobile); the server keeps connected-app tokens in memory only until the device collects them. Stick recordings are encrypted at rest.

## Not done yet

- **Stick firmware**: compile with the Xtensa toolchain and test on hardware. The ESP-IDF toolchain couldn't be installed in the environment this was built in. The platform code was syntax- and type-checked against the real ESP-IDF v5.5.6, TinyUSB 0.21.0, NimBLE and led_strip headers instead. Also still to do: beamforming and noise suppression, OTA updates, and a pairing gate for Bluetooth.
- **Mobile**: run on devices (the native microphone module and Bluetooth can't run in the browser preview), then App Store and Play Store setup.
- **Connected apps**: register Bibbly with each provider and run the server over HTTPS (see `docs/connectors.md`); Lark needs a live-tenant test. Sync runs while an app is open (no server-side background sync yet), and joining Zoom, Meet or Teams calls as a bot is next.
- USB IDs, the deb maintainer, code signing and notarization need your own accounts.
