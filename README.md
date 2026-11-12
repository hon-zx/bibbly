# Bibbly

Live multilingual captions, meeting notes, tasks and the Bibbly Stick.

Bibbly listens to a conversation, works out which language each person is speaking (including people who mix languages mid-sentence), and shows every line in each reader's own language. When the meeting ends you get Clarity notes: summary, decisions, action items and a follow-up. Action items become tasks with reminders, and notes export to Word, Markdown, text and subtitles for Teams, Zoom, Google Meet, Notion, Slack and Lark. The Bibbly Stick is a USB-C microphone that also records on its own and syncs later.

## What's here

| Path | What | Status |
|---|---|---|
| `packages/core` | Shared TypeScript engine: languages and detection, audio (resampling, voice activity, ADPCM, WAV), speech providers (Whisper-compatible, Azure, scripted demo), Claude translation and notes, live sessions, rooms protocol, exports, Stick protocol and client | 40 tests |
| `apps/desktop` | Electron app for Windows, macOS and Linux: live captions from the mic and meeting audio, a "captions for" switcher per language, Clarity notes, exports, tasks and calendar, Stick sync over USB, mini caption window | Type-checked, built; end-to-end test passes |
| `apps/server` | Rooms server: share live captions by link or QR code; each listener gets their own language (translated once per language) | 3 tests |
| `apps/mobile` | Expo app for iOS and Android: live captions, join a room in your language, notes, tasks with reminders, Stick sync over Bluetooth LE; native microphone module in Swift and Kotlin | Type-checked; Android and iOS bundles build; UI check passes |
| `firmware/bibbly-stick` | ESP32-S3 firmware: USB microphone + HID + WebUSB sync, encrypted microSD recorder, eyes and ring lights, Bluetooth LE, battery and sleep | Core logic: 507 checks + simulator; platform code checked against ESP-IDF headers (see below) |
| `docs/stick-protocol.md` | The Stick's link protocol | |

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

### Rooms server

```bash
ANTHROPIC_API_KEY=... node apps/server/dist/index.js        # PORT=8787 by default
```

In the desktop app, turn on **Share live captions** before starting, and guests join from a browser (`/join/<code>`) or the phone app. Without a key, listeners still get captions in the original language.

### Mobile

See `apps/mobile/README.md`. You need a development build (`npx expo run:ios` / `run:android`, or EAS) for the microphone and Bluetooth.

### Stick firmware

See `firmware/bibbly-stick/README.md`. `npm run firmware:test` builds and tests the device logic on your computer. Flashing a real Stick needs ESP-IDF v5.5 and the TinyUSB submodule.

## Checks

| Command | Covers |
|---|---|
| `npm test` | core (including TypeScript ↔ firmware tests against `stick-sim`) and server |
| `npm run typecheck` | all workspaces |
| `npm run firmware:test` | firmware unit tests and simulator smoke test |
| `npm run e2e -w @bibbly/desktop` | Electron app under Xvfb: demo meeting, language switch, save, export, tasks, Stick import |
| `cd apps/mobile && npm run typecheck && npm run bundle && npm run e2e` | mobile types, native bundles, phone-size UI check |

`.github/workflows/ci.yml` runs all of these on every push, and `firmware.yml` builds the ESP32-S3 image.

## Privacy

Notes, tasks and recordings stay on the device. Audio goes only to the speech engine you choose, and text only to Claude. API keys are kept in the OS keychain (desktop) or the iOS/Android keychain (mobile). Stick recordings are encrypted at rest.

## Not done yet

- **Stick firmware**: compile with the Xtensa toolchain and test on hardware. The ESP-IDF toolchain couldn't be installed in the environment this was built in. The platform code was syntax- and type-checked against the real ESP-IDF v5.5.6, TinyUSB 0.21.0, NimBLE and led_strip headers instead. Also still to do: beamforming and noise suppression, OTA updates, and a pairing gate for Bluetooth.
- **Mobile**: run on devices (the native microphone module and Bluetooth can't run in the browser preview), then App Store and Play Store setup.
- **Integrations**: notes go to Teams, Slack, Notion and Lark through exports and the share sheet. Direct posting through each service's API, and joining Zoom, Meet or Teams calls as a bot, are next.
- USB IDs, the deb maintainer, code signing and notarization need your own accounts.
