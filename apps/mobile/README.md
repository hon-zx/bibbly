# Bibbly for iOS and Android

Expo (SDK 58, React Native 0.88) app sharing `@bibbly/core` with the desktop app.

- **Live**: caption the conversation around you with the phone's microphone, play the demo meeting, or join a room someone is captioning on Bibbly for desktop and read along in your language. Every line shows the detected language, a translation for the reader and the original.
- **Notes**: meeting notes (summary, decisions, action items) in any language; turn action items into tasks; share as Word, Markdown, text or subtitles through the share sheet (Teams, Slack, Notion, Lark, Drive, mail).
- **Tasks**: quick add in plain words ("Send deck Friday 3pm #work"), with local reminders.
- **Stick**: find, pair and sync the Bibbly Stick over Bluetooth LE; import recordings into notes.
- **Settings**: your languages, speech engine (any Whisper-compatible server), Claude API key (kept in the keychain), rooms server.

## Run it

```bash
npm run build -w @bibbly/core      # from the repository root, once
cd apps/mobile && npm install
npx expo run:ios                   # or: npx expo run:android (needs Xcode / Android Studio)
```

The microphone streaming (`modules/bibbly-audio`, Swift and Kotlin) and Bluetooth are native code, so use a development build, not Expo Go. In Expo Go the demo meeting, rooms, notes and tasks still work.

Cloud builds: `npx eas build --platform android --profile preview` (see `eas.json`; run `eas init` first to link your Expo account).

## Checks

```bash
npm run typecheck
npm run bundle    # Metro bundles for Android and iOS
npm run e2e       # browser preview at phone size: demo meeting, notes, tasks, every tab
```
