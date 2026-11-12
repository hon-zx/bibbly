import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Runs the Bibbly Stick firmware logic compiled for this computer
 * (firmware/bibbly-stick/host, target "stick-sim"), speaking the same link
 * protocol over stdin/stdout. Lets the app be developed and tested without hardware.
 */
export class StickSimulator {
  private proc: ChildProcessWithoutNullStreams | null = null;

  constructor(private readonly onData: (bytes: Uint8Array) => void) {}

  binary(): string | null {
    const candidates = [
      process.env.BIBBLY_STICK_SIM,
      path.resolve(__dirname, '../../../build/firmware-host/stick-sim'),
      path.resolve(process.cwd(), '../../build/firmware-host/stick-sim'),
      path.resolve(process.cwd(), 'build/firmware-host/stick-sim'),
    ].filter((p): p is string => !!p);
    return candidates.find(p => fs.existsSync(p)) ?? null;
  }

  available(): boolean { return this.binary() !== null; }

  start(): boolean {
    if (this.proc) return true;
    const bin = this.binary();
    if (!bin) return false;
    const proc = spawn(bin, ['--demo-recordings'], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdout.on('data', (b: Buffer) => this.onData(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)));
    proc.stderr.on('data', (b: Buffer) => process.stderr.write(`[stick-sim] ${b.toString()}`));
    proc.on('exit', () => { if (this.proc === proc) this.proc = null; });
    this.proc = proc;
    return true;
  }

  write(bytes: Uint8Array): void { this.proc?.stdin.write(Buffer.from(bytes)); }

  stop(): void { this.proc?.kill(); this.proc = null; }
}
