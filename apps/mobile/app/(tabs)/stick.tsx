import { MODE_NAMES, STATE_NAMES, StatusFlags, fmtClock, type StickClient, type StickRecording, type StickStatus } from '@bibbly/core';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { askBluetoothPermission, connectStick, importRecording, scanForSticks } from '../../src/stick';
import { useTheme } from '../../src/theme';
import { Icon } from '../../src/ui/Icon';
import { Banner, Body, Button, Card, Chip, H2, Row, Screen, Title } from '../../src/ui/kit';
import { StickArt } from '../../src/ui/Mascot';

interface Found { id: string; name: string; rssi: number | null }

const fmtKb = (kb: number) => (kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${(kb / 1024).toFixed(1)} MB`);

export default function StickScreen() {
  const t = useTheme();
  const [found, setFound] = useState<Found[]>([]);
  const [scanning, setScanning] = useState(false);
  const [client, setClient] = useState<StickClient | null>(null);
  const [name, setName] = useState('');
  const [status, setStatus] = useState<StickStatus | null>(null);
  const [recs, setRecs] = useState<StickRecording[]>([]);
  const [busy, setBusy] = useState<{ id: number; p: number } | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'sun' | 'coral' | 'lagoon'; text: string; noteId?: string } | null>(null);
  const stopScan = useRef<(() => void) | null>(null);

  useEffect(() => () => { stopScan.current?.(); void client?.close(); }, [client]);

  const refresh = async (c: StickClient) => { setStatus(await c.status()); setRecs(await c.list()); };

  const scan = async () => {
    if (!(await askBluetoothPermission())) { setMessage({ tone: 'sun', text: 'Bibbly needs Bluetooth permission to find your Stick.' }); return; }
    setFound([]);
    setScanning(true);
    stopScan.current = scanForSticks(d => setFound(f => [...f, d]), msg => { setScanning(false); setMessage({ tone: 'coral', text: msg }); });
    setTimeout(() => setScanning(false), 20_000);
  };

  const connect = async (d: Found) => {
    stopScan.current?.();
    setScanning(false);
    setConnecting(d.id);
    try {
      const c = await connectStick(d.id);
      c.on('state', () => { void refresh(c); });
      c.on('button', e => setMessage({ tone: 'lagoon', text: e.gesture === 3 ? 'Recording toggled on the Stick.' : e.gesture === 2 ? 'Mode changed on the Stick.' : 'Button pressed on the Stick.' }));
      setClient(c);
      setName(d.name);
      await refresh(c);
    } catch (err) {
      setMessage({ tone: 'coral', text: err instanceof Error ? err.message : 'Could not connect to the Stick.' });
    } finally {
      setConnecting(null);
    }
  };

  const disconnect = async () => { await client?.close(); setClient(null); setStatus(null); setRecs([]); };

  const importRec = async (r: StickRecording) => {
    if (!client) return;
    setBusy({ id: r.id, p: 0 });
    try {
      const note = await importRecording(client, r, p => setBusy({ id: r.id, p }));
      await refresh(client);
      setMessage(note.pendingReason
        ? { tone: 'sun', text: 'Recording saved. Pick a speech engine in Settings to transcribe it.', noteId: note.id }
        : { tone: 'lagoon', text: 'Recording transcribed into a new note.', noteId: note.id });
    } catch (err) {
      setMessage({ tone: 'coral', text: err instanceof Error ? err.message : 'Import failed.' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen>
      <Title eyebrow="Bibbly Stick">{client ? 'Connected' : 'Your Stick'}</Title>
      <View style={{ alignItems: 'center' }}><StickArt connected={!!client} recording={status?.state === 2} width={280} /></View>
      {message ? (
        <Banner tone={message.tone} onClose={() => setMessage(null)}>
          {message.text}{message.noteId ? <Text style={{ fontWeight: '700' }} onPress={() => router.push(`/note/${message.noteId}`)}>  Open note</Text> : null}
        </Banner>
      ) : null}

      {!client ? (
        <Card>
          <H2>Sync over Bluetooth</H2>
          <Body muted>Recordings made away from your computer sync to this phone. Keep the Stick close; the first time, your phone asks to pair.</Body>
          <Button kind="primary" icon="bluetooth" label={scanning ? 'Looking for Sticks…' : 'Find my Stick'} busy={scanning && !found.length} onPress={() => void scan()} />
          {found.map(d => (
            <Row key={d.id} style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.ink, fontWeight: '600' }}>{d.name}</Text>
                {d.rssi != null ? <Text style={{ color: t.ink3, fontSize: 13 }}>{d.rssi > -60 ? 'Very close' : d.rssi > -80 ? 'Nearby' : 'Far away'}</Text> : null}
              </View>
              <Button small kind="soft" label="Connect" busy={connecting === d.id} onPress={() => void connect(d)} />
            </Row>
          ))}
        </Card>
      ) : (
        <>
          {status ? (
            <Card>
              <Row style={{ justifyContent: 'space-between' }}>
                <H2>{name}</H2>
                <Button small label="Disconnect" onPress={() => void disconnect()} />
              </Row>
              <Body>{STATE_NAMES[status.state] ?? 'Unknown'}{status.recordingMs ? ` · recording ${fmtClock(status.recordingMs / 1000)}` : ''}</Body>
              <Body muted small>
                {status.batteryPct == null ? 'USB powered' : `Battery ${status.batteryPct}%${status.charging ? ', charging' : ''}`} ·{' '}
                {status.flags & StatusFlags.NoStorage ? 'no card' : `${fmtKb(status.freeKb)} free${status.flags & StatusFlags.Encrypted ? ', encrypted' : ''}`}
              </Body>
              <Text style={{ color: t.ink, fontWeight: '600', marginTop: 4 }}>Mode</Text>
              <Row wrap>
                {MODE_NAMES.map((m, i) => (
                  <Chip key={m} label={m} selected={status.mode === i} onPress={() => void client.setMode(i).then(() => refresh(client))} />
                ))}
              </Row>
              <Button kind={status.state === 2 ? 'danger' : 'soft'} icon={status.state === 2 ? 'stop' : 'mic'}
                label={status.state === 2 ? 'Stop recording' : 'Record on the Stick'} onPress={() => void client.record(status.state !== 2).then(() => refresh(client))} />
            </Card>
          ) : null}
          <Card>
            <Row style={{ justifyContent: 'space-between' }}>
              <H2>Recordings</H2>
              <Button small icon="refresh" label="Refresh" onPress={() => void refresh(client)} />
            </Row>
            {recs.length === 0 ? <Body muted>No recordings. Long-press the Stick’s button to record when it isn’t plugged in.</Body> : null}
            {recs.map(r => (
              <Row key={r.id} style={{ justifyContent: 'space-between', opacity: r.synced ? 0.7 : 1 }}>
                <Icon n="mic" color={t.coral} size={18} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: t.ink, fontWeight: '600' }}>Recording {r.id}</Text>
                  <Text style={{ color: t.ink3, fontSize: 13 }}>
                    {r.startEpochMs ? new Date(r.startEpochMs).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'Time not set'} · {fmtClock(r.durationMs / 1000)}
                    {busy?.id === r.id ? ` · ${Math.round(busy.p * 100)}%` : ''}
                  </Text>
                </View>
                <Button small kind={r.synced ? 'ghost' : 'primary'} label={r.synced ? 'Again' : 'Import'} busy={busy?.id === r.id} disabled={!!busy && busy.id !== r.id}
                  onPress={() => void importRec(r)} />
              </Row>
            ))}
          </Card>
        </>
      )}
      <Card tone="lagoon">
        <H2>Plugged into a computer?</H2>
        <Body>The Stick is a standard USB microphone there, and Bibbly for desktop syncs it over USB, faster than Bluetooth.</Body>
      </Card>
    </Screen>
  );
}
