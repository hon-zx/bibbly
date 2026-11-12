// UI check of the phone app in its browser preview, at phone size (run: npm run e2e).
// Plays the demo meeting, switches the caption language, waits for Clarity notes,
// saves the note, adds a task and visits every tab. Bluetooth and the microphone
// are native-only, so they are covered by device testing, not here.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/node-tools/node_modules/playwright'); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist-web');
if (!fs.existsSync(path.join(root, 'index.html'))) { console.error('Build the preview first: npm run preview:web'); process.exit(1); }
const shots = process.env.BIBBLY_SHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'bibbly-mobile-'));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const target = file.startsWith(root) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(root, 'index.html');
  res.writeHead(200, { 'Content-Type': types[path.extname(target)] ?? 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
}).listen(0);
const url = `http://localhost:${server.address().port}/`;
const step = s => console.log(`✓ ${s}`);

const browser = await playwright.chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.getByText('Live captions').first().waitFor({ timeout: 30_000 });
  step('Live tab');
  await page.getByText('Play the demo meeting').click();
  await page.getByText('Hi everyone', { exact: false }).first().waitFor({ timeout: 30_000 });
  step('demo captions arrive, translated into English');
  await page.getByRole('button', { name: 'Captions in 简体中文' }).first().click();
  await page.getByText('新加坡这边已经准备好了', { exact: false }).first().waitFor({ timeout: 30_000 });
  step('captions switch to what a Chinese reader sees');
  await page.getByRole('button', { name: 'Captions in English' }).first().click();
  await page.getByText('English + Mandarin').first().waitFor({ timeout: 40_000 });
  step('mixed-language line detected');
  await page.getByText('Action items', { exact: false }).first().waitFor({ timeout: 40_000 });
  await page.screenshot({ path: path.join(shots, 'live.png') });
  step('Clarity notes during the meeting');
  await page.getByText('Stop & save').click();
  await page.getByText('That’s a wrap').waitFor({ timeout: 30_000 });
  await page.getByText('Open the note').click();
  await page.getByText('Make them to-dos').waitFor({ timeout: 10_000 });
  await page.getByText('Add').first().click();
  await page.getByText('Added').first().waitFor({ timeout: 5_000 });
  await page.screenshot({ path: path.join(shots, 'note.png') });
  step('note saved; an action item became a task');
  await page.goBack();
  await page.getByText('Tasks').last().click();
  await page.getByLabel('Add a task').fill('Send deck to Li Wei tomorrow 3pm');
  await page.keyboard.press('Enter');
  await page.getByText('Upcoming').click();
  await page.getByText('Send deck to Li Wei').waitFor({ timeout: 5_000 });
  await page.getByText('All', { exact: true }).click();
  await page.getByText('Send packaging files to Sato').waitFor({ timeout: 5_000 });
  await page.screenshot({ path: path.join(shots, 'tasks.png') });
  step('quick-add task parsed; the meeting task is listed');
  await page.getByText('Stick').last().click();
  await page.getByText('Find my Stick').waitFor({ timeout: 5_000 });
  await page.getByText('Settings').last().click();
  await page.getByText('You and your languages').waitFor({ timeout: 5_000 });
  step('Stick and Settings tabs');
  if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
  step('no page errors');
  console.log(`screenshots in ${shots}`);
} finally {
  await browser.close();
  server.close();
}
