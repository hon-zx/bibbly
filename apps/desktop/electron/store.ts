import fs from 'node:fs';
import path from 'node:path';
import type { AppData } from '../src/shared/ipc.js';
import { DEFAULT_SETTINGS } from './seed.js';

/** JSON file store with atomic writes (write to a temp file, then rename). */
export class DataStore {
  data!: AppData;
  private timer: NodeJS.Timeout | null = null;
  private readonly file: string;

  constructor(dir: string) { this.file = path.join(dir, 'bibbly-data.json'); }

  async load(seed: () => Promise<AppData>): Promise<AppData> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as AppData;
      if (parsed?.version !== 1) throw new Error('unknown data version');
      this.data = { ...parsed, settings: { ...DEFAULT_SETTINGS, ...parsed.settings } };
    } catch (err) {
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.unreadable-${Date.now()}`);
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[bibbly] could not read saved data, starting fresh:', err);
      this.data = await seed();
      this.saveNow();
    }
    return this.data;
  }

  update(patch: Partial<AppData>): AppData {
    this.data = { ...this.data, ...patch };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 400);
    return this.data;
  }

  saveNow(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}
