/**
 * The Bibbly Stick over Bluetooth LE: the same link protocol and StickClient
 * as USB on desktop, carried by one GATT service (see firmware main/ble.c).
 */
import {
  LiveSession, Resampler, StickClient, int16ToFloat, type DecodedWav, type Note, type StickRecording, type StickTransport,
} from '@bibbly/core';
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, type Device, type Subscription } from 'react-native-ble-plx';
import { fromBase64, toBase64 } from './base64';
import { claude, speechProvider } from './services';
import { getData, saveNote } from './store';

export const STICK_SERVICE = 'b1bb1e00-5e1c-4b1d-9a8e-7a51c0de0001';
const RX = 'b1bb1e00-5e1c-4b1d-9a8e-7a51c0de0002'; // app -> Stick
const TX = 'b1bb1e00-5e1c-4b1d-9a8e-7a51c0de0003'; // Stick -> app

let manager: BleManager | null = null;
const ble = () => (manager ??= new BleManager());

export async function askBluetoothPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  if (Platform.Version >= 31) {
    const r = await PermissionsAndroid.requestMultiple([PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]);
    return Object.values(r).every(v => v === PermissionsAndroid.RESULTS.GRANTED);
  }
  const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  return r === PermissionsAndroid.RESULTS.GRANTED;
}

/** Looks for Sticks nearby; calls back once per Stick found. Returns a stop function. */
export function scanForSticks(found: (d: { id: string; name: string; rssi: number | null }) => void, failed: (msg: string) => void): () => void {
  const seen = new Set<string>();
  ble().startDeviceScan([STICK_SERVICE], { allowDuplicates: false }, (err, device) => {
    if (err) { failed(err.message); return; }
    if (device && !seen.has(device.id)) {
      seen.add(device.id);
      found({ id: device.id, name: device.name ?? device.localName ?? 'Bibbly Stick', rssi: device.rssi });
    }
  });
  const stop = setTimeout(() => { void ble().stopDeviceScan(); }, 20_000);
  return () => { clearTimeout(stop); void ble().stopDeviceScan(); };
}

class BleTransport implements StickTransport {
  private sinks = new Set<(b: Uint8Array) => void>();
  private sub: Subscription | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly device: Device) {
    this.sub = device.monitorCharacteristicForService(STICK_SERVICE, TX, (err, ch) => {
      if (err || !ch?.value) return;
      const bytes = fromBase64(ch.value);
      this.sinks.forEach(cb => cb(bytes));
    });
  }

  write(bytes: Uint8Array): Promise<void> {
    // Writes are queued and split to fit the link (the Stick reassembles frames).
    const mtu = this.device.mtu || 23;
    const chunk = Math.max(20, mtu - 3);
    this.queue = this.queue.then(async () => {
      for (let i = 0; i < bytes.length; i += chunk) {
        await this.device.writeCharacteristicWithResponseForService(STICK_SERVICE, RX, toBase64(bytes.subarray(i, i + chunk)));
      }
    });
    return this.queue;
  }

  onData(cb: (b: Uint8Array) => void): () => void { this.sinks.add(cb); return () => this.sinks.delete(cb); }

  async close(): Promise<void> {
    this.sub?.remove();
    this.sub = null;
    await this.device.cancelConnection().catch(() => undefined);
  }
}

/** Connects (pairing on first use) and returns a client for the Stick. */
export async function connectStick(id: string): Promise<StickClient> {
  await ble().stopDeviceScan();
  let device = await ble().connectToDevice(id, { requestMTU: 517, timeout: 15_000 });
  device = await device.discoverAllServicesAndCharacteristics();
  const client = new StickClient(new BleTransport(device), 8000);
  await client.ping(); // first request triggers pairing; the Stick needs an encrypted link
  await client.setTime(Date.now());
  return client;
}

/** Downloads a recording and turns it into a note (transcribed when a speech engine is set up). */
export async function importRecording(client: StickClient, rec: StickRecording, onProgress: (p: number) => void): Promise<Note> {
  const wav: DecodedWav = await client.readDecoded(rec, onProgress);
  const s = getData().settings;
  const ai = claude();
  const provider = speechProvider();
  const started = rec.startEpochMs || Date.now();
  const title = `Stick recording, ${new Date(started).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
  let note: Note;
  if (!provider) {
    note = {
      id: `stick-${rec.id}-${started}`, title, startedAt: started, durationSec: Math.round(rec.durationMs / 1000), source: 'Bibbly Stick (offline recording)',
      languages: [s.myLang], speakers: [], lines: [], clarity: null, sentTo: [],
      pendingReason: 'Pick a speech engine in Settings, then import this recording again to transcribe it.',
    };
  } else {
    const session = new LiveSession({
      title, me: { id: 'me', name: s.myName || 'You', self: true }, myLang: s.myLang, candidateLanguages: [...new Set([s.myLang, ...s.speaking])],
      glossary: s.glossary, autoClarityEvery: 0, source: 'Bibbly Stick (offline recording)',
    }, { translator: ai, clarity: ai });
    await session.attach('stick', provider, { diarize: true });
    const pcm = wav.sampleRate === 16_000 ? wav.samples : new Resampler(wav.sampleRate, 16_000).process(int16ToFloat(wav.samples));
    for (let i = 0; i < pcm.length; i += 3200) session.write('stick', pcm.subarray(i, i + 3200));
    await session.stop();
    note = session.toNote({ startedAt: started, durationSec: Math.round(rec.durationMs / 1000) });
  }
  saveNote(note);
  await client.markSynced(rec.id);
  return note;
}
