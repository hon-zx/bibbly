// End-to-end check of the real desktop app (run with: npm run e2e, needs a display or xvfb).
// Plays the demo meeting, checks captions and translations, saves the note, exports Markdown,
// and (when the firmware simulator is built) imports a recording from the Bibbly Stick.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/node-tools/node_modules/playwright'); }
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bibbly-e2e-'));
const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bibbly-export-'));
const shots = process.env.BIBBLY_SHOTS ?? path.join(os.tmpdir(), 'bibbly-shots');
fs.mkdirSync(shots, { recursive: true });
const step = msg => console.log(`✓ ${msg}`);

const electronPath = createRequire(path.join(appDir, 'package.json'))('electron');
const app = await playwright._electron.launch({
  executablePath: electronPath, args: ['--no-sandbox', '.'], cwd: appDir,
  env: { ...process.env, BIBBLY_USER_DATA: userData, BIBBLY_EXPORT_DIR: exportDir, ANTHROPIC_API_KEY: '' },
});
const errors = [];
try {
  const win = await app.firstWindow();
  win.on('pageerror', e => errors.push(e.message));
  win.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await win.setViewportSize({ width: 1320, height: 860 }).catch(() => {});
  await win.waitForSelector('text=Start a session', { timeout: 20_000 });
  step('app opened on Live');
  await win.screenshot({ path: path.join(shots, 'desktop-start.png') });

  await win.click('text=Play the demo meeting');
  await win.waitForSelector('.cap:not(.cap--partial) >> nth=3', { timeout: 40_000 });
  const firstMain = await win.locator('.cap:not(.cap--partial) .cap-main').first().textContent();
  if (!/Hi everyone/.test(firstMain ?? '')) throw new Error(`expected an English translation of the first line, got: ${firstMain}`);
  step('demo captions arrive, translated into English');
  await win.click('.lchip:has-text("中文")');
  await win.waitForFunction(() => [...document.querySelectorAll('.cap .cap-main')].some(e => e.textContent?.includes('新加坡这边已经准备好了')), null, { timeout: 10_000 });
  step('"Captions for" switches to what a Chinese reader sees');
  await win.screenshot({ path: path.join(shots, 'desktop-live.png') });
  await win.click('.lchip:has-text("You")');

  await win.click('text=Stop & save');
  await win.waitForSelector('text=That’s a wrap', { timeout: 30_000 });
  step('session stopped and saved');
  await win.click('.endcard >> text=Open the note');
  await win.waitForSelector('.note-head h2', { timeout: 10_000 });
  await win.screenshot({ path: path.join(shots, 'desktop-note.png') });
  await win.click('button[role="radio"]:has-text("Export & share")');
  await win.click('.ex-file:has-text("Markdown")');
  const deadline = Date.now() + 10_000;
  let md = null;
  while (Date.now() < deadline && !md) { md = fs.readdirSync(exportDir).find(f => f.endsWith('.md')) ?? null; if (!md) await new Promise(r => setTimeout(r, 200)); }
  if (!md) throw new Error('Markdown export did not appear');
  const text = fs.readFileSync(path.join(exportDir, md), 'utf8');
  if (!text.includes('## Transcript') || !text.includes('Li Wei')) throw new Error('Markdown export is missing content');
  step(`exported ${md}`);

  await win.click('.nav-i:has-text("Tasks")');
  await win.fill('.quick-input', 'Send deck to Li Wei tomorrow 3pm');
  await win.click('.quick button[type="submit"]');
  await win.click('.fchip:has-text("Upcoming")');
  await win.waitForSelector('.ttitle:has-text("Send deck to Li Wei")', { timeout: 5_000 });
  step('quick-add task parsed and listed');
  await win.screenshot({ path: path.join(shots, 'desktop-tasks.png') });

  await win.click('.nav-i:has-text("Bibbly Stick")');
  await win.waitForSelector('text=Connect over USB', { timeout: 5_000 });
  const sim = await win.waitForSelector('text=Use the simulator', { timeout: 3_000 }).catch(() => null);
  if (sim) {
    await win.click('text=Use the simulator');
    await win.waitForSelector('.rec-list li', { timeout: 10_000 });
    await win.screenshot({ path: path.join(shots, 'desktop-stick.png') });
    await win.click('.rec-list li >> nth=0 >> text=Import');
    await win.waitForSelector('.toast:has-text("Recording")', { timeout: 30_000 });
    step('imported a recording from the Stick simulator');
  } else {
    console.log('– Stick simulator not built; skipped the import check');
  }
  const fatal = errors.filter(e => !/Autofill|DevTools|Electron Security Warning/.test(e));
  if (fatal.length) throw new Error(`renderer errors:\n${fatal.join('\n')}`);
  step('no renderer errors');
} finally {
  await app.close();
}
console.log(`screenshots in ${shots}`);
