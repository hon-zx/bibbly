/**
 * Talks to the real Bibbly Stick firmware logic, compiled for this computer
 * (build/firmware-host/stick-sim, built by `npm run firmware:test`), through
 * the same StickClient the apps use. Skipped when the simulator isn't built.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeWav, encodeWavIma } from '../src/audio/wav.js';
import { StickClient, type StickTransport } from '../src/stick/client.js';
import { DeviceState, Gesture, StatusFlags } from '../src/stick/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SIM = process.env.BIBBLY_STICK_SIM ?? path.resolve(here, '../../../build/firmware-host/stick-sim');
const built = fs.existsSync(SIM);

function stdioTransport(proc: ChildProcessWithoutNullStreams): StickTransport {
  return {
    async write(bytes) { proc.stdin.write(Buffer.from(bytes)); },
    onData(cb) {
      const h = (b: Buffer) => cb(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
      proc.stdout.on('data', h);
      return () => proc.stdout.off('data', h);
    },
    async close() { proc.stdin.end(); },
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe.skipIf(!built)('Bibbly Stick simulator (firmware C code)', () => {
  it('records WAV files byte-identical to encodeWavIma()', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stick-wav-'));
    const n = 16_000 * 2 + 777; // not a whole number of ADPCM blocks
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / 16_000;
      pcm[i] = Math.round(12_000 * Math.sin(2 * Math.PI * (200 + 900 * t) * t) + 3000 * Math.sin(2 * Math.PI * 3100 * t));
    }
    const input = path.join(dir, 'in.raw');
    const output = path.join(dir, 'out.wav');
    fs.writeFileSync(input, Buffer.from(pcm.buffer));
    const epoch = 1_794_470_400_123;
    const summary = JSON.parse(execFileSync(SIM, ['--wav-from-pcm', input, output, '--epoch', String(epoch)], { encoding: 'utf8' }));
    const fromFirmware = new Uint8Array(fs.readFileSync(output));
    const fromTs = encodeWavIma(pcm, 16_000, epoch);
    expect(fromFirmware.length).toBe(fromTs.length);
    expect(Buffer.compare(Buffer.from(fromFirmware), Buffer.from(fromTs))).toBe(0);
    expect(summary).toMatchObject({ size: fromTs.length, durationMs: Math.floor((n * 1000) / 16_000) });
    const decoded = decodeWav(fromFirmware);
    expect(decoded.samples.length).toBe(n);
    expect(decoded.stick?.startEpochMs).toBe(epoch);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('over the link protocol', () => {
    let proc: ChildProcessWithoutNullStreams;
    let client: StickClient;
    beforeAll(() => {
      proc = spawn(SIM, ['--demo-recordings'], { stdio: ['pipe', 'pipe', 'pipe'] });
      client = new StickClient(stdioTransport(proc), 5000);
    });
    afterAll(async () => {
      await client.close();
      await new Promise<void>(resolve => { if (proc.exitCode !== null) resolve(); else proc.on('exit', () => resolve()); });
    });

    it('identifies itself and reports status', async () => {
      expect(await client.ping()).toBeGreaterThanOrEqual(0);
      const info = await client.info();
      expect(info).toMatchObject({ protocol: 1, firmware: '0.1.0-sim', flashKb: 16384 });
      expect(info.serial).toMatch(/^bb[0-9a-f]{14}$/);
      await client.setTime(Date.now());
      const st = await client.status();
      expect(st).toMatchObject({ state: DeviceState.Idle, batteryPct: 82, charging: true, mode: 0, recordings: 3 });
      expect(st.totalKb).toBeGreaterThan(st.freeKb - 1);
      expect(st.flags & StatusFlags.ClockSet).toBeTruthy();
      expect(st.flags & StatusFlags.Usb).toBeTruthy();
    });

    it('lists and downloads the demo recordings', async () => {
      const recs = await client.list();
      expect(recs.map(r => r.id)).toEqual([1, 2, 3]);
      expect(recs.map(r => r.durationMs)).toEqual([9000, 15000, 6000]);
      expect(recs[0]!.synced).toBe(true);
      expect(recs[1]!.startEpochMs).toBeLessThan(recs[2]!.startEpochMs);
      const progress: number[] = [];
      const wav = await client.readDecoded(recs[1]!, p => progress.push(p));
      expect(wav.sampleRate).toBe(16_000);
      expect(wav.samples.length).toBe(15 * 16_000);
      expect(wav.stick?.startEpochMs).toBe(recs[1]!.startEpochMs);
      expect(progress.length).toBeGreaterThan(20);
      expect(progress.at(-1)).toBe(1);
      let energy = 0;
      for (const s of wav.samples) energy += s * s;
      expect(Math.sqrt(energy / wav.samples.length)).toBeGreaterThan(300); // there is talking in it
    });

    it('records, marks synced and deletes from the app', async () => {
      const started = await client.record(true);
      expect(started).toMatchObject({ state: DeviceState.Recording, id: 4 });
      await sleep(700);
      expect((await client.status()).recordingMs).toBeGreaterThan(300);
      await expect(client.remove(4)).rejects.toThrow(/busy/i);
      const stopped = await client.record(false);
      expect(stopped).toMatchObject({ state: DeviceState.Idle, id: 4 });
      let recs = await client.list();
      expect(recs).toHaveLength(4);
      expect(recs[3]!.durationMs).toBeGreaterThan(400);
      await client.markSynced(4);
      expect((await client.list())[3]!.synced).toBe(true);
      await client.remove(4);
      recs = await client.list();
      expect(recs.map(r => r.id)).toEqual([1, 2, 3]);
      await expect(client.remove(4)).rejects.toThrow(/no longer on the Stick/);
      expect(await client.setMode(2)).toBe(2);
      await expect(client.setMode(9)).rejects.toThrow(/rejected/);
      await client.ledTest(1);
    });

    it('sends button and state events (long press records)', async () => {
      const gestures: number[] = [];
      const states: number[] = [];
      client.on('button', e => gestures.push(e.gesture));
      client.on('state', e => states.push(e.state));
      proc.kill('SIGUSR1'); // long press
      await sleep(400);
      proc.kill('SIGUSR1');
      await sleep(400);
      expect(gestures).toEqual([Gesture.Long, Gesture.Long]);
      expect(states).toEqual([DeviceState.Recording, DeviceState.Idle]);
      expect((await client.list())).toHaveLength(4);
    });
  });
});
