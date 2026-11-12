import { useEffect, useRef, useState } from 'react';
import { MODE_NAMES, STATE_NAMES, StickClient, fmtClock, type StickInfo, type StickRecording, type StickStatus, type StickTransport } from '@bibbly/core';
import { api } from '../api';
import { go, toast } from '../store';
import { SimulatorTransport, WebUsbTransport } from '../stick/transports';
import { fmtTime, relDay } from '../ui/bits';
import { Icon } from '../ui/Icon';
import { StickArt } from '../ui/Mascot';

interface Conn { client: StickClient; info: StickInfo; kind: 'usb' | 'simulator' }

export function StickScreen() {
  const [conn, setConn] = useState<Conn | null>(null);
  const [status, setStatus] = useState<StickStatus | null>(null);
  const [recs, setRecs] = useState<StickRecording[]>([]);
  const [busy, setBusy] = useState<{ id: number; progress: number } | null>(null);
  const [simAvailable, setSimAvailable] = useState(false);
  const connRef = useRef<Conn | null>(null);
  useEffect(() => { void api.stick.simulatorAvailable().then(setSimAvailable); return () => { void connRef.current?.client.close(); }; }, []);

  const refresh = async (c: Conn) => { setStatus(await c.client.status()); setRecs(await c.client.list()); };

  const connect = async (kind: 'usb' | 'simulator') => {
    try {
      const transport: StickTransport = kind === 'usb' ? await WebUsbTransport.request() : await SimulatorTransport.start();
      const client = new StickClient(transport);
      const info = await client.info();
      await client.setTime(Date.now());
      client.on('button', e => toast(e.gesture === 3 ? 'Stick: long press (recording toggled on the Stick).' : e.gesture === 2 ? 'Stick: double press (mode changed).' : 'Stick: button pressed.'));
      client.on('state', () => { if (connRef.current) void refresh(connRef.current); });
      const c: Conn = { client, info, kind };
      connRef.current = c;
      setConn(c);
      await refresh(c);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') return; // picker closed
      toast(err instanceof Error ? err.message : 'Could not connect to the Stick.');
    }
  };

  const disconnect = async () => { await conn?.client.close(); connRef.current = null; setConn(null); setStatus(null); setRecs([]); };

  const importRec = async (r: StickRecording) => {
    if (!conn) return;
    try {
      setBusy({ id: r.id, progress: 0 });
      const bytes = await conn.client.read(r, p => setBusy({ id: r.id, progress: p }));
      const note = await api.stick.importRecording(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        { startedAt: r.startEpochMs, durationMs: r.durationMs, title: `Stick recording, ${relDay(r.startEpochMs)} ${fmtTime(r.startEpochMs)}` });
      await conn.client.markSynced(r.id);
      await refresh(conn);
      toast(note.pendingReason ? 'Recording saved. Pick a speech engine in Settings to transcribe it.' : 'Recording transcribed into a new note.',
        { mascot: 'happy', action: { label: 'Open', run: () => go('notes', { noteId: note.id }) } });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Import failed.');
    } finally { setBusy(null); }
  };

  const remove = async (r: StickRecording) => { if (!conn) return; await conn.client.remove(r.id); await refresh(conn); toast('Recording deleted from the Stick.'); };

  return (
    <div className="page stick">
      <section className="stick-hero">
        <div className="stick-art"><StickArt connected={!!conn} recording={status?.state === 2} /></div>
        <div className="stick-copy">
          <p className="eyebrow">Bibbly Stick</p>
          <h1 className="h1">{conn ? 'Connected' : 'Connect your Stick'}</h1>
          <p className="lede">Plugged in, the Stick is a USB microphone for live captions. Unplugged, it records on its own; import those recordings here and Bibbly turns them into notes and tasks.</p>
          <div className="row">
            {conn ? <button className="btn" onClick={() => void disconnect()}>Disconnect</button> : (
              <>
                <button className="btn primary" onClick={() => void connect('usb')}><Icon n="usb" />Connect over USB</button>
                {simAvailable && <button className="btn" onClick={() => void connect('simulator')}>Use the simulator</button>}
              </>
            )}
            {conn && <span className="status-pill on"><span className="dot" />{conn.kind === 'usb' ? 'USB-C' : 'Simulator'} · firmware {conn.info.firmware}</span>}
          </div>
        </div>
      </section>
      {conn && status && (
        <>
          <section className="stat-grid">
            <div className="stat"><span className="stat-k">State</span><span className="stat-v">{STATE_NAMES[status.state] ?? 'Unknown'}</span><span className="stat-s">{status.recordingMs ? `Recording ${fmtClock(status.recordingMs / 1000)}` : 'Ready'}</span></div>
            <div className="stat"><span className="stat-k">Battery</span><span className="stat-v tnum">{status.batteryPct == null ? 'USB' : `${status.batteryPct}%`}</span><span className="stat-s">{status.charging ? 'Charging' : status.batteryPct == null ? 'Powered over USB' : 'On battery'}</span></div>
            <div className="stat"><span className="stat-k">Storage</span><span className="stat-v tnum">{(status.freeKb / 1024).toFixed(1)} MB</span><span className="stat-s">free of {(status.totalKb / 1024).toFixed(1)} MB</span></div>
            <div className="stat"><span className="stat-k">Mode</span>
              <span className="select"><select aria-label="Stick mode" value={status.mode} onChange={async e => { await conn.client.setMode(Number(e.target.value)); await refresh(conn); }}>
                {MODE_NAMES.map((m, i) => <option key={m} value={i}>{m}</option>)}</select><Icon n="down" size={16} /></span>
              <span className="stat-s">Serial {conn.info.serial.slice(-8)}</span></div>
          </section>
          <section className="card recs">
            <div className="card-head"><h2 className="h3">Recordings on your Stick</h2>
              <div className="row"><button className="btn sm" onClick={() => void conn.client.record(status.state !== 2).then(() => refresh(conn))}><Icon n={status.state === 2 ? 'stop' : 'mic'} />{status.state === 2 ? 'Stop recording' : 'Record on the Stick'}</button>
                <button className="icon-btn" aria-label="Refresh" onClick={() => void refresh(conn)}><Icon n="refresh" /></button></div></div>
            <ul className="rec-list">{recs.map(r => (
              <li key={r.id} className={r.synced ? 'done' : ''}>
                <span className="rec-ic"><Icon n="mic" /></span>
                <span className="rec-body"><b>Recording {r.id}</b><span>{r.startEpochMs ? `${relDay(r.startEpochMs)} ${fmtTime(r.startEpochMs)}` : 'Time not set'} · {fmtClock(r.durationMs / 1000)} · {(r.size / 1024).toFixed(0)} KB</span>
                  {busy?.id === r.id && <span className="bar" role="progressbar" aria-valuenow={Math.round(busy.progress * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${busy.progress * 100}%` }} /></span>}</span>
                <span className="rec-state">
                  <button className="btn sm primary" disabled={!!busy} onClick={() => void importRec(r)}>{r.synced ? 'Import again' : 'Import'}</button>
                  <button className="icon-btn sm" aria-label={`Delete recording ${r.id}`} disabled={!!busy} onClick={() => void remove(r)}><Icon n="trash" size={16} /></button>
                </span>
              </li>))}</ul>
            {!recs.length && <p className="muted">No recordings on the Stick. Long-press its button to record when it isn’t plugged in.</p>}
          </section>
        </>
      )}
      <section className="card">
        <h2 className="h3">How the Stick connects</h2>
        <ol className="steps">
          <li><b>Plug into USB-C.</b> The computer sees a standard microphone, so it works without drivers, even on locked-down work laptops.</li>
          <li><b>Pick it in Live.</b> Tick “Bibbly Stick microphone” and Bibbly captions everyone around the table.</li>
          <li><b>Sync recordings.</b> Recordings made away from the computer appear above; import them to get a transcript, notes and to-dos.</li>
        </ol>
        <p className="hint">On Linux, install the udev rule from the Bibbly package so the sync interface can be opened without root.</p>
      </section>
    </div>
  );
}
