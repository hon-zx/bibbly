import { LANGUAGES, langNative } from '@bibbly/core';
import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { micAvailable } from '../../modules/bibbly-audio';
import { setSecret, useSecretStatus, type SecretName } from '../../src/secrets';
import { updateSettings, useData } from '../../src/store';
import { useTheme } from '../../src/theme';
import { Body, Button, Card, Chip, Field, H2, Row, Screen, Title } from '../../src/ui/kit';

function SecretField({ name, label, hint, placeholder }: { name: SecretName; label: string; hint: string; placeholder: string }) {
  const t = useTheme();
  const status = useSecretStatus();
  const [value, setValue] = useState('');
  const saved = status[name];
  return (
    <View style={{ gap: 8 }}>
      <Field label={label} hint={hint} value={value} onChangeText={setValue} placeholder={saved ? 'Saved in the keychain' : placeholder}
        secureTextEntry autoCapitalize="none" autoCorrect={false} textContentType="password" />
      <Row>
        <Button small kind="primary" label="Save key" disabled={!value.trim()} onPress={() => { void setSecret(name, value).then(() => setValue('')); }} />
        {saved ? <Button small label="Remove" onPress={() => void setSecret(name, null)} /> : null}
        {saved ? <Text style={{ color: t.lagoon, fontWeight: '600' }}>Saved</Text> : null}
      </Row>
    </View>
  );
}

export default function SettingsScreen() {
  const t = useTheme();
  const s = useData(d => d.settings);
  const toggleSpeaking = (code: string) =>
    updateSettings({ speaking: s.speaking.includes(code) ? s.speaking.filter(c => c !== code) : [...s.speaking, code] });

  return (
    <Screen>
      <Title eyebrow="Settings">You and your languages</Title>
      <Card>
        <Field label="Your name" value={s.myName} onChangeText={v => updateSettings({ myName: v })} hint="Shown on your lines and in shared notes." />
        <Text style={{ color: t.ink, fontWeight: '600' }}>Show me captions and notes in</Text>
        <Row wrap>{LANGUAGES.map(l => <Chip key={l.code} label={l.native} selected={s.myLang === l.code} onPress={() => updateSettings({ myLang: l.code })} />)}</Row>
        <Text style={{ color: t.ink, fontWeight: '600', marginTop: 6 }}>People around me speak</Text>
        <Body muted small>Bibbly detects the language of every line on its own; these are hints for the speech engine.</Body>
        <Row wrap>{LANGUAGES.map(l => <Chip key={l.code} label={langNative(l.code)} selected={s.speaking.includes(l.code)} onPress={() => toggleSpeaking(l.code)} />)}</Row>
      </Card>

      <Card>
        <H2>Speech recognition</H2>
        <Row wrap>
          <Chip label="Demo only" selected={s.engine === 'demo'} onPress={() => updateSettings({ engine: 'demo' })} />
          <Chip label="Whisper-compatible server" selected={s.engine === 'whisper'} onPress={() => updateSettings({ engine: 'whisper' })} />
        </Row>
        {s.engine === 'whisper' ? (
          <>
            <Field label="Server address" value={s.whisperUrl} onChangeText={v => updateSettings({ whisperUrl: v })} autoCapitalize="none" autoCorrect={false}
              keyboardType="url" hint="Any server with /v1/audio/transcriptions: OpenAI, Groq, or your own faster-whisper. Each utterance gets its own language." />
            <SecretField name="whisperKey" label="Server key (if it needs one)" hint="Stored in the phone’s keychain." placeholder="sk-…" />
          </>
        ) : <Body muted small>The demo meeting works without a speech engine. Live captions from the microphone need one.</Body>}
        {!micAvailable ? <Body muted small>This build has no microphone module (Expo Go). Use a development build for live captions.</Body> : null}
      </Card>

      <Card>
        <H2>Translation and notes</H2>
        <Body muted small>Bibbly uses Claude to translate every line for each reader and to write meeting notes. Your key stays on this phone.</Body>
        <SecretField name="anthropicKey" label="Claude API key" hint="Create one in the Claude Console. Stored in the phone’s keychain." placeholder="sk-ant-…" />
        <Button small label="Open the Claude Console" onPress={() => void Linking.openURL('https://console.anthropic.com/')} />
        <Field label="Model" value={s.claudeModel} onChangeText={v => updateSettings({ claudeModel: v.trim() })} autoCapitalize="none" autoCorrect={false} />
        <Field label="Names and terms to keep as they are" value={s.glossary.join(', ')} autoCapitalize="none"
          onChangeText={v => updateSettings({ glossary: v.split(',').map(x => x.trim()).filter(Boolean) })} hint="Comma separated, e.g. product and people names." />
      </Card>

      <Card>
        <H2>Rooms</H2>
        <Field label="Rooms server" value={s.roomServer} onChangeText={v => updateSettings({ roomServer: v.trim() })} autoCapitalize="none" autoCorrect={false}
          keyboardType="url" hint="Where Bibbly for desktop shares live captions (apps/server). Join with the room code on the Live tab." />
      </Card>

      <Card tone="lagoon">
        <H2>Privacy</H2>
        <Body>Notes, tasks and recordings stay on this phone. Audio goes only to the speech server you choose, and text only to Claude. API keys live in the keychain.</Body>
      </Card>
    </Screen>
  );
}
