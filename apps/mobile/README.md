# Bibbly for iOS and Android

Expo (SDK 58, React Native 0.88) app sharing `@bibbly/core` and `@bibbly/connectors` with the desktop app.

- **Live**: caption the conversation around you with the phone's microphone, play the demo meeting, or join a room someone is captioning on Bibbly for desktop and read along in your language. Every line shows the detected language, a translation for the reader and the original. Upcoming meetings from your connected calendars show here, with a Join button.
- **Notes**: meeting notes (summary, decisions, action items) in any language; turn action items into tasks; send them straight to a connected Slack channel, Notion page, Google Doc, Teams channel or Lark chat (or automatically after each meeting); or share Word, Markdown, text or subtitles through the share sheet.
- **Tasks**: quick add in plain words ("Send deck Friday 3pm #work"), with local reminders; synced both ways with Google Tasks, Microsoft To Do or Lark Tasks when connected.
- **Stick**: find, pair and sync the Bibbly Stick over Bluetooth LE; import recordings into notes.
- **Settings**: your languages, speech engine (any Whisper-compatible server), Claude API key (kept in the keychain), connected apps, and the Bibbly server address.

## Run it

```bash
npm run build:libs                 # from the repository root: builds @bibbly/core and @bibbly/connectors
cd apps/mobile && npm install
npx expo run:ios                   # or: npx expo run:android (needs Xcode / Android Studio)
```

The microphone streaming (`modules/bibbly-audio`, Swift and Kotlin) and Bluetooth are native code, so use a development build, not Expo Go. In Expo Go the demo meeting, rooms, notes and tasks still work.

Connected apps sign in through the Bibbly server (set its address in Settings; see `docs/connectors.md`), which returns to the app at `bibbly://oauth`. That scheme only exists in a development or release build, so connect apps there rather than in Expo Go. Sign-ins are kept in the phone's keychain, split into chunks to stay within SecureStore's size limit.

Cloud builds: `npx eas build --platform android --profile preview` (see `eas.json`; run `eas init` first to link your Expo account).

## Checks

```bash
npm run typecheck
npm run bundle    # Metro bundles for Android and iOS
npm run e2e       # browser preview at phone size: demo meeting, notes, tasks, every tab, then connecting Google and Slack
                  # through a local Bibbly server against fake providers (tasks and calendar sync, sending a note)
```
