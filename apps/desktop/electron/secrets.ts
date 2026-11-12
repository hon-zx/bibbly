import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { SecretName, SecretStatus } from '../src/shared/ipc.js';

const NAMES: SecretName[] = ['anthropicKey', 'azureKey', 'whisperKey'];

/** API keys encrypted with the operating system keychain (Keychain, DPAPI, libsecret). */
export class Secrets {
  private readonly file: string;
  private cache: Partial<Record<SecretName, string>> = {};

  constructor(dir: string) {
    this.file = path.join(dir, 'secrets.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, string>;
      for (const n of NAMES) {
        const v = raw[n];
        if (v && safeStorage.isEncryptionAvailable()) this.cache[n] = safeStorage.decryptString(Buffer.from(v, 'base64'));
      }
    } catch { /* no secrets saved yet */ }
  }

  get(name: SecretName): string | null { return this.cache[name] ?? null; }

  set(name: SecretName, value: string | null): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Your system keychain is not available, so Bibbly cannot store keys safely. Set ANTHROPIC_API_KEY in your environment instead.');
    const v = value?.trim();
    if (v) this.cache[name] = v; else delete this.cache[name];
    const out: Record<string, string> = {};
    for (const n of NAMES) { const s = this.cache[n]; if (s) out[n] = safeStorage.encryptString(s).toString('base64'); }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(out), { mode: 0o600 });
  }

  status(): SecretStatus {
    let backend = 'system keychain';
    try { if (process.platform === 'linux') backend = safeStorage.getSelectedStorageBackend(); } catch { /* older Electron */ }
    return { anthropicKey: !!this.cache.anthropicKey, azureKey: !!this.cache.azureKey, whisperKey: !!this.cache.whisperKey,
             envAnthropic: !!process.env.ANTHROPIC_API_KEY, backend };
  }
}
