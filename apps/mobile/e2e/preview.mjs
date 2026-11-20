// UI check of the phone app in its browser preview, at phone size (run: npm run e2e).
// Plays the demo meeting, switches the caption language, waits for Clarity notes,
// saves the note, adds a task and visits every tab. Then connects Slack and Google
// through a local Bibbly server (the sign-in broker) against fake provider servers:
// tasks sync to Google Tasks, Google Calendar meetings show up, and a note goes to
// Slack. Bluetooth and the microphone are native-only, so they are covered by
// device testing, not here.
import { endpointsAt } from '@bibbly/connectors';
import { startFakes } from '@bibbly/connectors/testing';
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

// Fake Google and Slack, and a Bibbly server whose sign-in broker uses them. The preview build
// sends provider calls to this port (EXPO_PUBLIC_BIBBLY_PROVIDER_BASE_URL in the e2e script).
const fake = await startFakes({ port: 47123 });
const here = path.dirname(fileURLToPath(import.meta.url));
const { startServer } = await import(path.resolve(here, '../../server/dist/server.js'));
const bibbly = await startServer({
  port: 0, host: '127.0.0.1', translator: null,
  oauth: { clients: { google: { clientId: 'g-web', clientSecret: 'g-web-secret' }, slack: { clientId: 'slack-client', clientSecret: 'slack-secret' } }, endpoints: endpointsAt(fake.url) },
});
const soon = new Date(Date.now() + 60 * 60_000);
fake.google.events.set('ev-vendor', { id: 'ev-vendor', etag: '"1"', summary: 'Vendor call', hangoutLink: 'https://meet.google.com/abc-defg-hij',
  start: { dateTime: soon.toISOString() }, end: { dateTime: new Date(soon.getTime() + 30 * 60_000).toISOString() } });

const browser = await playwright.chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  const clues = (globalThis.__clues = []);
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') clues.push(`console ${m.type()}: ${m.text().slice(0, 300)}`); });
  page.on('popup', p => { clues.push(`popup opened: ${p.url()}`); p.on('framenavigated', f => { if (f === p.mainFrame()) clues.push(`popup at: ${f.url().slice(0, 160)}`); }); p.on('close', () => clues.push('popup closed')); });
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

  // Connected apps through the Bibbly server: each sign-in runs in a popup and returns to /oauth.
  await page.getByLabel('Server address').fill(`http://127.0.0.1:${bibbly.port}`);
  const slack = page.getByTestId('app-slack');
  await slack.getByRole('button', { name: 'Connect' }).click({ timeout: 10_000 });
  await page.getByText('Acme (Slack)').waitFor({ timeout: 20_000 });
  step('Slack connected through the Bibbly server');
  await page.getByTestId('app-google').getByRole('button', { name: 'Connect' }).click();
  await page.getByText('ada@example.com').waitFor({ timeout: 20_000 });
  await page.getByTestId('app-google').getByText('Synced', { exact: false }).waitFor({ timeout: 20_000 });
  const gTitles = [...fake.google.tasks.values()].flat().map(t => t.title);
  if (!gTitles.includes('Send deck to Li Wei')) throw new Error(`the new task did not reach Google Tasks: ${JSON.stringify(gTitles)}`);
  if (gTitles.some(t => /Try the demo|Claude API key/.test(t))) throw new Error('welcome tasks should stay on the phone');
  if (fake.google.tokenRequests.at(-1)?.client_secret !== 'g-web-secret') throw new Error('the client secret should only be used by the server');
  await page.screenshot({ path: path.join(shots, 'apps.png') });
  step('Google connected; tasks synced to Google Tasks');

  await page.getByText('Live').last().click();
  await page.getByText('Up next').waitFor({ timeout: 10_000 });
  await page.getByText('Vendor call').waitFor({ timeout: 5_000 });
  step('Google Calendar meetings show on the Live tab');

  await page.getByText('Notes').last().click();
  await page.getByText('Q4 launch sync', { exact: false }).first().click();
  const send = page.getByTestId('send-slack');
  await send.getByRole('button', { name: '#general' }).click({ timeout: 10_000 });
  await send.getByRole('button', { name: 'Send' }).click();
  await page.getByText('Sent to #general.').waitFor({ timeout: 10_000 });
  if (fake.slack.messages[0]?.channel !== 'C1') throw new Error('the note did not reach Slack #general');
  await page.screenshot({ path: path.join(shots, 'send.png') });
  step('note sent to Slack #general');
  if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
  step('no page errors');
  console.log(`screenshots in ${shots}`);
} catch (err) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) await page.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {});
  console.error(['what happened:', ...(globalThis.__clues ?? []), `fake provider requests: ${fake.log.slice(-12).join(' | ')}`].join('\n  '));
  throw err;
} finally {
  await browser.close();
  server.close();
  await bibbly.close();
  await fake.close();
}
