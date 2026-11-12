import { LANGUAGES } from '@bibbly/core';

/** The page guests open from the room link or QR code. Self-contained: no external assets. */
export function listenerPage(room: string, translationOn: boolean): string {
  const langs = JSON.stringify(LANGUAGES.filter(l => l.code !== 'yue').map(l => ({ code: l.code, native: l.native, name: l.name, spoken: l.spoken, tag: l.tag, rtl: !!l.rtl })));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Bibbly live captions</title>
<style>
:root { --bg:#EDF4F1; --surface:#fff; --ink:#12302C; --ink2:#48635E; --ink3:#6D8580; --line:#D2E2DC; --lagoon:#0A7A69; --soft:#D5F1E9; --sun:#FFF1C9; --sunInk:#6B4A00; --coral:#BF3F2B; --body:#8BE3CF; --belly:#D7F7EF; --outline:#15403B; }
@media (prefers-color-scheme: dark) { :root { --bg:#0A1618; --surface:#10211F; --ink:#E2F1EC; --ink2:#A6C2BB; --ink3:#7F9A94; --line:#234440; --lagoon:#45D3B6; --soft:#12362F; --sun:#3A3016; --sunInk:#FFE3A3; --coral:#FF907A; color-scheme: dark; } }
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans", "Microsoft YaHei", sans-serif; display: flex; flex-direction: column; }
header { display: flex; align-items: center; gap: 10px; padding: 10px max(16px, env(safe-area-inset-right)) 10px max(16px, env(safe-area-inset-left)); background: var(--surface); border-bottom: 1px solid var(--line); position: sticky; top: 0; }
header h1 { font-size: 18px; margin: 0; flex: 1; }
header small { color: var(--ink3); font-weight: 600; }
select, input, button { font: inherit; color: inherit; }
select, input { min-height: 42px; border-radius: 12px; border: 1px solid var(--line); background: var(--surface); padding: 0 12px; }
button { min-height: 44px; border-radius: 999px; border: 0; background: var(--lagoon); color: #fff; font-weight: 700; padding: 0 20px; cursor: pointer; }
main { flex: 1; overflow-y: auto; padding: 16px max(16px, env(safe-area-inset-right)) 32px max(16px, env(safe-area-inset-left)); }
.join { max-width: 420px; margin: 8vh auto 0; display: grid; gap: 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 22px; padding: 22px; }
.join h2 { margin: 0; font-size: 22px; }
.join p { margin: 0; color: var(--ink2); }
label { display: grid; gap: 6px; font-weight: 600; font-size: 14px; color: var(--ink2); }
.cap { display: grid; gap: 4px; padding: 12px 0; border-bottom: 1px dashed var(--line); max-width: 860px; margin: 0 auto; }
.meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 13px; color: var(--ink3); }
.who { font-weight: 700; color: var(--ink); font-size: 14px; }
.chip { font-size: 12px; font-weight: 600; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); }
.chip.mixed { background: var(--sun); color: var(--sunInk); }
.main { font-size: 19px; overflow-wrap: anywhere; }
.orig { font-size: 15px; color: var(--ink2); border-left: 2.5px solid var(--line); padding-left: 10px; overflow-wrap: anywhere; }
.pending { color: var(--ink3); font-style: italic; }
.partial .main { color: var(--ink2); font-style: italic; }
.notice { max-width: 860px; margin: 0 auto 12px; padding: 10px 14px; border-radius: 14px; background: var(--soft); color: var(--ink); font-size: 14px; }
.notice.warn { background: var(--sun); color: var(--sunInk); }
.empty { text-align: center; color: var(--ink3); margin-top: 12vh; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<header>
  <svg width="34" height="34" viewBox="0 0 200 200" aria-hidden="true"><path d="M100 34C142 34 170 60 170 98C170 136 144 160 104 162C92 163 80 162 70 159C62 168 47 174 33 172C41 165 46 156 46 148C36 138 30 120 30 100C30 60 58 34 100 34Z" fill="var(--body)" stroke="var(--outline)" stroke-width="8" stroke-linejoin="round"/><ellipse cx="82" cy="94" rx="10" ry="13" fill="var(--outline)"/><ellipse cx="118" cy="94" rx="10" ry="13" fill="var(--outline)"/><path d="M90 113q10 10 20 0" fill="none" stroke="var(--outline)" stroke-width="6" stroke-linecap="round"/></svg>
  <h1>Bibbly live captions <small>· ${room}</small></h1>
  <select id="lang" aria-label="Caption language" hidden></select>
</header>
<main id="main">
  <form class="join" id="join">
    <h2>Follow this meeting in your language</h2>
    <p>Captions appear as people speak, translated into the language you pick.</p>
    <label>Your name <input id="name" maxlength="40" autocomplete="nickname" placeholder="e.g. Mei"></label>
    <label>Show captions in <select id="joinLang"></select></label>
    <button type="submit">Join</button>
  </form>
  <div id="feed" hidden></div>
</main>
<script>
(() => {
  const ROOM = ${JSON.stringify(room)};
  const TRANSLATION_ON = ${translationOn ? 'true' : 'false'};
  const LANGS = ${langs};
  const byCode = Object.fromEntries(LANGS.map(l => [l.code, l]));
  const $ = id => document.getElementById(id);
  const lines = new Map();
  const tr = {};
  let me = { name: '', lang: 'en' }, ws = null, partial = null, ended = false, retries = 0;
  const guess = (navigator.language || 'en').toLowerCase();
  const initial = guess.startsWith('zh') ? (/(tw|hk|hant)/.test(guess) ? 'zh-Hant' : 'zh') : (byCode[guess.slice(0, 2)] ? guess.slice(0, 2) : 'en');
  for (const sel of [$('lang'), $('joinLang')]) for (const l of LANGS) { const o = document.createElement('option'); o.value = l.code; o.textContent = l.native + (l.native !== l.name ? ' · ' + l.name : ''); sel.append(o); }
  $('joinLang').value = initial;
  try { $('name').value = localStorage.getItem('bibbly.name') || ''; } catch {}

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function label(line) { return (line.langs && line.langs.length > 1 ? line.langs : [line.lang]).map(c => byCode[c] ? byCode[c].spoken : c).join(' + '); }
  function render() {
    const feed = $('feed');
    feed.textContent = '';
    if (!TRANSLATION_ON) feed.append(el('p', 'notice warn', 'Translation is off on this server, so captions show in the language spoken.'));
    if (ended) feed.append(el('p', 'notice', 'The host ended the session. The captions stay here until you close the page.'));
    if (!lines.size && !partial) feed.append(el('p', 'empty', 'Waiting for someone to speak…'));
    for (const line of lines.values()) {
      const box = el('article', 'cap');
      const meta = el('div', 'meta');
      meta.append(el('span', 'who', line.speaker), el('span', 'chip' + (line.langs && line.langs.length > 1 ? ' mixed' : ''), label(line)));
      box.append(meta);
      const same = line.lang === me.lang && !(line.langs && line.langs.length > 1);
      const t = tr[line.id + '|' + me.lang];
      const main = el('p', 'main', same ? line.text : (t || line.text));
      main.lang = byCode[same || !t ? line.lang : me.lang]?.tag || line.lang;
      box.append(main);
      if (!same && t) { const o = el('p', 'orig', line.text); o.lang = byCode[line.lang]?.tag || line.lang; box.append(o); }
      else if (!same && TRANSLATION_ON) box.append(el('p', 'pending', 'Translating…'));
      feed.append(box);
    }
    if (partial && partial.text) {
      const box = el('article', 'cap partial');
      const meta = el('div', 'meta'); meta.append(el('span', 'who', partial.speaker || 'Speaking'));
      box.append(meta, el('p', 'main', partial.text + ' …'));
      feed.append(box);
    }
    const m = $('main'); m.scrollTop = m.scrollHeight;
  }
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws');
    ws.onopen = () => { retries = 0; ws.send(JSON.stringify({ t: 'hello', v: 1, room: ROOM, role: 'listener', name: me.name, lang: me.lang })); };
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'welcome') { for (const l of m.history || []) lines.set(l.id, l); for (const [id, text] of Object.entries(m.translations || {})) tr[id + '|' + me.lang] = text; }
      else if (m.t === 'caption') { lines.set(m.line.id, m.line); partial = null; }
      else if (m.t === 'translation') tr[m.id + '|' + m.lang] = m.text;
      else if (m.t === 'partial') partial = m;
      else if (m.t === 'ended') ended = true;
      else if (m.t === 'error') { const f = $('feed'); f.prepend(el('p', 'notice warn', m.message)); return; }
      render();
    };
    ws.onclose = e => { if (e.code === 4004) { $('feed').textContent = ''; $('feed').append(el('p', 'notice warn', 'This room has not started yet. Keep this page open; it reconnects when the host starts.')); } setTimeout(connect, Math.min(10000, 1000 * 2 ** retries++)); };
  }
  $('join').addEventListener('submit', e => {
    e.preventDefault();
    me = { name: ($('name').value || 'Guest').slice(0, 40), lang: $('joinLang').value };
    try { localStorage.setItem('bibbly.name', me.name); } catch {}
    $('join').hidden = true; $('feed').hidden = false; $('lang').hidden = false; $('lang').value = me.lang;
    render(); connect();
  });
  $('lang').addEventListener('change', () => { me.lang = $('lang').value; if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'lang', lang: me.lang })); render(); });
})();
</script>
</body>
</html>`;
}
