/** Connected apps on the phone: the Settings card, "Send to" on a note, and upcoming meetings on the Live tab. */
import { PROVIDERS, PROVIDER_IDS, type ConnectedAccount, type NoteTarget, type ProviderId, type SyncStatus } from '@bibbly/connectors';
import type { CalendarEvent, LangCode, Note, Platform as MeetingPlatform } from '@bibbly/core';
import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import {
  canSignIn, checkServer, connect, disconnect, noteTargets, publish, syncNow, updateAccountSettings, useConnectors,
} from '../connectors';
import { useData } from '../store';
import { useTheme } from '../theme';
import { Icon } from './Icon';
import { Banner, Body, Button, Card, Chip, Field, H2, Row } from './kit';

const MEETING: Partial<Record<ProviderId, string>> = { google: 'Google Meet', microsoft: 'Teams', lark: 'Lark meeting' };
const PLATFORM: Record<MeetingPlatform, string> = { zoom: 'Zoom', teams: 'Teams', meet: 'Google Meet', lark: 'Lark', 'in-person': 'In person', other: 'Meeting' };

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function ago(at: number): string {
  const m = Math.round((Date.now() - at) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function statusText(st: SyncStatus | undefined, syncing: boolean): string {
  if (syncing) return 'Syncing…';
  if (!st) return 'Not synced yet';
  if (!st.ok) return st.message ?? 'Sync failed.';
  return `Synced ${ago(st.at)}`;
}

function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  const t = useTheme();
  return (
    <View style={styles.toggle}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.ink, fontWeight: '600' }}>{label}</Text>
        {hint ? <Text style={{ color: t.ink3, fontSize: 13 }}>{hint}</Text> : null}
      </View>
      <Switch accessibilityLabel={label} value={value} onValueChange={onChange} trackColor={{ true: t.lagoon, false: t.fill }} thumbColor={t.surface} />
    </View>
  );
}

/** Settings: connect Google, Microsoft 365, Slack, Notion and Lark, and choose what syncs. */
export function ConnectedAppsCard() {
  const v = useConnectors();
  const [error, setError] = useState<string | null>(null);
  const server = useData(d => d.settings.roomServer);
  useEffect(() => {
    const h = setTimeout(() => void checkServer(), 600); // after the address stops changing
    return () => clearTimeout(h);
  }, [server]);
  const syncs = v.state.accounts.some(a => a.settings.calendar?.enabled || a.settings.tasks?.enabled);
  return (
    <Card>
      <H2>Connected apps</H2>
      <Body muted small>Tasks and your calendar sync both ways while Bibbly is open. Notes go to Slack, Notion, Google Docs, Teams or Lark.</Body>
      {v.server === null ? <Banner tone="sun">Sign-in goes through your Bibbly server (below), which isn’t reachable right now{v.serverError ? `: ${v.serverError}` : '.'}</Banner> : null}
      {error ? <Banner tone="coral" onClose={() => setError(null)}>{error}</Banner> : null}
      {PROVIDER_IDS.map(p => <ProviderBlock key={p} id={p} onError={setError} />)}
      {syncs ? <Button small icon="refresh" label={v.syncing ? 'Syncing…' : 'Sync now'} busy={v.syncing} onPress={() => void syncNow()} /> : null}
    </Card>
  );
}

function ProviderBlock({ id, onError }: { id: ProviderId; onError: (m: string) => void }) {
  const t = useTheme();
  const v = useConnectors();
  const info = PROVIDERS[id];
  const accounts = v.state.accounts.filter(a => a.provider === id);
  const signIn = canSignIn(v, id);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [token, setToken] = useState('');
  const run = (p: Promise<unknown>) => p.catch(err => onError(errText(err)));
  return (
    <View testID={`app-${id}`} style={[styles.block, { borderTopColor: t.line }]}>
      <Row style={{ justifyContent: 'space-between' }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.ink, fontWeight: '700', fontSize: 16 }}>{info.name}{info.beta ? ' · beta' : ''}</Text>
          <Text style={{ color: t.ink3, fontSize: 13 }}>{info.capabilities.map(c => info.labels[c]).join(' · ')}</Text>
        </View>
        {v.connecting === id
          ? <Text style={{ color: t.ink3 }}>Finish in the browser…</Text>
          : signIn ? <Button small kind={accounts.length ? 'ghost' : 'primary'} label={accounts.length ? 'Add' : 'Connect'} onPress={() => void run(connect(id))} /> : null}
      </Row>
      {!signIn && !accounts.length && v.server ? <Body muted small>Your Bibbly server isn’t set up for {info.name} yet{info.tokenHint ? '; you can paste a token instead' : ''}.</Body> : null}
      {info.tokenHint ? (tokenOpen ? (
        <View style={{ gap: 8 }}>
          <Field label={`${info.name} token`} hint={info.tokenHint} value={token} onChangeText={setToken} secureTextEntry autoCapitalize="none" autoCorrect={false} />
          <Row>
            <Button small kind="primary" label="Connect" disabled={!token.trim()} onPress={() => void run(connect(id, token).then(() => { setToken(''); setTokenOpen(false); }))} />
            <Button small label="Cancel" onPress={() => setTokenOpen(false)} />
          </Row>
        </View>
      ) : <Button small icon="key" label="Use a token" onPress={() => setTokenOpen(true)} />) : null}
      {accounts.map(a => <AccountBlock key={a.id} a={a} onError={onError} />)}
    </View>
  );
}

function AccountBlock({ a, onError }: { a: ConnectedAccount; onError: (m: string) => void }) {
  const t = useTheme();
  const v = useConnectors();
  const info = PROVIDERS[a.provider];
  const st = v.state.status[a.id];
  const [targets, setTargets] = useState<NoteTarget[] | null>(null);
  const { calendar: cal, tasks, notes } = a.settings;
  const set = (patch: Partial<typeof a.settings>) => updateAccountSettings(a.id, { ...a.settings, ...patch });
  return (
    <View style={[styles.account, { backgroundColor: t.surface2, borderColor: t.line }]}>
      <Row style={{ justifyContent: 'space-between' }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.ink, fontWeight: '600' }}>{a.label}</Text>
          <Text style={{ color: st && !st.ok ? t.coral : t.ink3, fontSize: 13 }} accessibilityLiveRegion="polite">
            {cal || tasks ? statusText(st, v.syncing) : 'Connected'}</Text>
        </View>
        <Button small label="Disconnect" onPress={() => void disconnect(a.id).catch(err => onError(errText(err)))} />
      </Row>
      {cal ? <Toggle label={info.labels.calendar ?? 'Calendar'} hint="Your meetings for the next 30 days." value={cal.enabled} onChange={on => set({ calendar: { ...cal, enabled: on } })} /> : null}
      {cal?.enabled ? <Toggle label="Save follow-ups here" hint={MEETING[a.provider] ? `With a ${MEETING[a.provider]} link.` : undefined} value={cal.push} onChange={on => set({ calendar: { ...cal, push: on } })} /> : null}
      {tasks ? <Toggle label={info.labels.tasks ?? 'Tasks'} hint={`Two-way with the “${tasks.listName}” list.`} value={tasks.enabled} onChange={on => set({ tasks: { ...tasks, enabled: on } })} /> : null}
      {notes ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: t.ink, fontWeight: '600' }}>{info.labels.notes}</Text>
          {a.provider === 'google'
            ? <Text style={{ color: t.ink3, fontSize: 13 }}>Saved as Google Docs in a “Bibbly notes” folder.</Text>
            : targets
              ? <Row wrap>{targets.slice(0, 20).map(x => <Chip key={x.id} label={x.name} selected={notes.target?.id === x.id} onPress={() => set({ notes: { ...notes, target: x } })} />)}</Row>
              : <Row><Text style={{ color: t.ink3, fontSize: 13, flex: 1 }}>{notes.target ? `Notes go to ${notes.target.name}.` : 'Choose where notes go.'}</Text>
                  <Button small label={notes.target ? 'Change' : 'Choose'} onPress={() => void noteTargets(a.id).then(setTargets).catch(err => onError(errText(err)))} /></Row>}
          {notes.target || a.provider === 'google'
            ? <Toggle label="Send every note after a meeting" value={notes.auto} onChange={on => set({ notes: { ...notes, auto: on } })} /> : null}
        </View>
      ) : null}
    </View>
  );
}

/** On a note: send it straight to a connected app. */
export function SendToCard({ note, lang }: { note: Note; lang: LangCode }) {
  const t = useTheme();
  const v = useConnectors();
  const accounts = v.state.accounts.filter(a => a.settings.notes?.enabled);
  return (
    <Card>
      <H2>Send to a connected app</H2>
      {accounts.length
        ? accounts.map(a => <SendRow key={a.id} a={a} note={note} lang={lang} />)
        : <Body muted small>Connect Slack, Notion, Google, Microsoft Teams or Lark in Settings to send notes straight there.</Body>}
      {note.shared?.map(c => (
        <Row key={`${c.provider}-${c.at}`}>
          <Icon n="tick" color={t.lagoon} size={16} />
          <Text style={{ color: t.ink2, flex: 1 }}>Sent to {c.target}</Text>
          {c.url ? <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(c.url!)} hitSlop={8}><Text style={{ color: t.lagoon, fontWeight: '600' }}>Open</Text></Pressable> : null}
        </Row>
      ))}
    </Card>
  );
}

function SendRow({ a, note, lang }: { a: ConnectedAccount; note: Note; lang: LangCode }) {
  const t = useTheme();
  const info = PROVIDERS[a.provider];
  const pick = a.provider !== 'google';
  const [targets, setTargets] = useState<NoteTarget[] | null>(null);
  const [target, setTarget] = useState<NoteTarget | null>(a.settings.notes?.target ?? null);
  const [state, setState] = useState<{ busy?: boolean; error?: string; done?: string }>({});
  useEffect(() => { if (pick) void noteTargets(a.id).then(setTargets).catch(err => setState({ error: errText(err) })); }, [a.id, pick]);
  const send = async () => {
    setState({ busy: true });
    try { const c = await publish(note, a.id, target, lang); setState({ done: `Sent to ${c.target}.` }); }
    catch (err) { setState({ error: errText(err) }); }
  };
  return (
    <View testID={`send-${a.provider}`} style={[styles.account, { backgroundColor: t.surface2, borderColor: t.line }]}>
      <Text style={{ color: t.ink, fontWeight: '600' }}>{info.labels.notes} · <Text style={{ color: t.ink3, fontWeight: '400' }}>{a.label}</Text></Text>
      {pick ? <Row wrap>{(targets ?? (target ? [target] : [])).slice(0, 20).map(x => <Chip key={x.id} label={x.name} selected={target?.id === x.id} onPress={() => setTarget(x)} />)}</Row> : null}
      {state.error ? <Text style={{ color: t.coral, fontSize: 13 }}>{state.error}</Text> : null}
      {state.done ? <Text style={{ color: t.lagoon, fontSize: 13 }}>{state.done}</Text> : null}
      <Button small kind="primary" icon="share" label="Send" busy={state.busy} disabled={pick && !target} onPress={() => void send()} />
    </View>
  );
}

/** Live tab: the next meetings from connected calendars, with a join link. */
export function UpNextCard() {
  const t = useTheme();
  const events = useData(d => d.events);
  const now = Date.now();
  const next = events.filter(e => e.start + e.durationMin * 60_000 > now).sort((a, b) => a.start - b.start).slice(0, 3);
  if (!next.length) return null;
  return (
    <Card>
      <H2>Up next</H2>
      {next.map((e: CalendarEvent) => (
        <Row key={e.id} style={{ alignItems: 'flex-start' }}>
          <Icon n="clock" color={t.ink3} size={18} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.ink, fontWeight: '600' }}>{e.title}</Text>
            <Text style={{ color: t.ink3, fontSize: 13 }}>
              {new Date(e.start).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} · {PLATFORM[e.platform]}{e.source ? ` · ${PROVIDERS[e.source.provider].labels.calendar}` : ''}
            </Text>
          </View>
          {e.meetUrl ? <Button small kind="soft" label="Join" onPress={() => void Linking.openURL(e.meetUrl!)} /> : null}
        </Row>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  block: { gap: 8, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  account: { gap: 8, padding: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
});
