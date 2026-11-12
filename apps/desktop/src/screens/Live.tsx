import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  clarityLabel, fmtClock, isRtl, itemText, langNative, langTag, lineText, type Clarity, type LangCode, type Line, type Note, type PartialLine,
} from '@bibbly/core';
import { api } from '../api';
import { addActionAsTask, addFollowUp, closeLive, discardSession, go, saveSettings, setState, setViewLang, startSession, stopSession, useApp, type LiveView } from '../store';
import { Avatar, DueChip, Empty, LangChip, LangSelect, OUT_LANGS, Seg, speakerColor, fmtTime, relDay, Toggle } from '../ui/bits';
import { Icon } from '../ui/Icon';
import { Mascot, type MascotState } from '../ui/Mascot';

export function LiveScreen() {
  const { live } = useApp();
  return live ? <LiveSession L={live} /> : <LiveStart />;
}

function LiveStart() {
  const { data, secrets } = useApp();
  const [channels, setChannels] = useState({ mic: true, system: false, stick: false });
  const [shareRoom, setShareRoom] = useState(false);
  if (!data) return null;
  const s = data.settings;
  const engineReady = s.engine !== 'demo';
  const claudeReady = !!(secrets?.anthropicKey || secrets?.envAnthropic);
  return (
    <div className="page live-start">
      <section className="ls-hero">
        <Mascot state="wave" size={108} />
        <div><p className="eyebrow">Live</p><h1 className="h1">Start a session</h1>
          <p className="lede">Bibbly works out who is speaking and in which language, then shows each person captions in the language they chose.</p></div>
      </section>
      <div className="ls-options">
        <button className="option" onClick={() => void startSession({ mode: 'demo', channels: { mic: false, system: false, stick: false }, shareRoom })}>
          <span className="option-ic demo"><Icon n="play" size={22} /></span>
          <span className="option-text"><span className="option-title">Play the demo meeting</span><span className="option-sub">Three speakers in Mandarin, English and Japanese. Works without any API keys.</span></span>
          <Icon n="arrow" />
        </button>
        <button className={`option${engineReady ? '' : ' off'}`} disabled={!engineReady || !(channels.mic || channels.system || channels.stick)}
          onClick={() => void startSession({ mode: 'live', channels, shareRoom })}>
          <span className="option-ic mic"><Icon n="mic" size={22} /></span>
          <span className="option-text"><span className="option-title">Caption a real meeting</span>
            <span className="option-sub">{engineReady ? `Speech: ${s.engine === 'azure' ? 'Azure AI Speech' : 'Whisper server'} · ${claudeReady ? 'translation on' : 'add a Claude key for translation'}` : 'Choose a speech engine in Settings first.'}</span></span>
          <Icon n="arrow" />
        </button>
      </div>
      <section className="card ls-settings">
        <div className="field"><span className="flabel">Listen to</span>
          <div className="checks">
            <label className="check-row"><input type="checkbox" checked={channels.mic} onChange={e => setChannels({ ...channels, mic: e.target.checked })} />My microphone</label>
            <label className="check-row"><input type="checkbox" checked={channels.system} onChange={e => setChannels({ ...channels, system: e.target.checked })} />Meeting audio from this computer (Zoom, Teams, Meet, Lark)</label>
            <label className="check-row"><input type="checkbox" checked={channels.stick} onChange={e => setChannels({ ...channels, stick: e.target.checked })} />Bibbly Stick microphone</label>
          </div>
        </div>
        <div className="field"><label htmlFor="ls-lang">My caption language</label>
          <LangSelect id="ls-lang" value={s.myLang} onChange={v => void saveSettings({ myLang: v })} label="My caption language" />
          <p className="hint">People can speak any of: {s.speaking.map(langNative).join(', ')}. Change this in Settings.</p></div>
        <div className="field"><span className="flabel">Share live captions</span>
          <div className="row"><Toggle id="ls-room" on={shareRoom} onChange={setShareRoom} label="Share a room link" /><span>Give others a link or QR code to follow in their language</span></div>
          <p className="hint">Uses the rooms server at {s.roomServer}.</p></div>
      </section>
    </div>
  );
}

const PEOPLE_LANGS: { lang: LangCode; label: string }[] = [{ lang: 'en', label: 'English' }, { lang: 'zh', label: '中文' }, { lang: 'ja', label: '日本語' }];

function LiveSession({ L }: { L: LiveView }) {
  const { data, levels } = useApp();
  const [tab, setTab] = useState<'captions' | 'clarity'>('captions');
  const [clock, setClock] = useState(0);
  useEffect(() => {
    if (L.status !== 'live') return;
    const t = setInterval(() => setClock(Math.floor((Date.now() - L.startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [L.status, L.startedAt]);
  if (!data) return null;
  const myLang = data.settings.myLang;
  const partial = Object.values(L.partials).find(p => p && p.text) ?? null;
  const mascot: MascotState = L.clarityState === 'working' ? 'think' : L.status === 'ended' ? 'happy' : partial ? 'listen' : 'translate';
  const choices = [{ lang: myLang, label: 'You' }, ...PEOPLE_LANGS.filter(p => p.lang !== myLang).map(p => ({ ...p, label: `Someone reading ${p.label}` }))];
  return (
    <div className={`lv${tab === 'clarity' ? ' show-clarity' : ''}`}>
      <section className="live-main">
        <header className="live-head">
          <div className="lh-row">
            <div className="lh-title">
              <div className="lh-status">
                <span className={`rec-pill ${L.status === 'live' ? 'running' : L.status}`}><span className="rec-dot" />{L.status === 'live' ? 'Live' : L.status === 'stopping' ? 'Saving' : 'Ended'}<span className="tnum">{fmtClock(L.status === 'live' ? clock : (L.lines.at(-1)?.t ?? 0))}</span></span>
                <span className="lh-mode">{L.mode === 'demo' ? 'Demo meeting · example data' : 'Live audio'}</span>
                {Object.entries(levels).map(([ch, v]) => <span key={ch} className="meter" title={`${ch} level`}><span style={{ width: `${Math.min(100, (v ?? 0) * 400)}%` }} /></span>)}
              </div>
              <h1 className="lh-name">{L.title}</h1>
            </div>
            <div className="lh-actions">
              {L.status === 'live' ? (
                <>
                  <button className="btn sq" title="Mini captions" aria-label="Show mini captions" onClick={() => void api.mini.toggle()}><Icon n="pip" /></button>
                  <button className="btn ghost" onClick={() => void discardSession()}>Discard</button>
                  <button className="btn danger" onClick={() => void stopSession()}><Icon n="stop" />Stop & save</button>
                </>
              ) : (
                <>
                  {L.noteId && <button className="btn primary" onClick={() => go('notes', { noteId: L.noteId ?? null })}><Icon n="notes" />Open the note</button>}
                  <button className="btn" onClick={closeLive}><Icon n="plus" />New session</button>
                </>
              )}
            </div>
          </div>
          <div className="listeners">
            <span className="lb-label">Captions for</span>
            <div className="lb-chips" role="radiogroup" aria-label="Whose captions to show">
              {choices.map(c => (
                <button key={c.lang} role="radio" aria-checked={L.viewLang === c.lang} className={`lchip${L.viewLang === c.lang ? ' on' : ''}`} onClick={() => void setViewLang(c.lang)}>
                  <span className="lchip-name">{c.label}</span><span className="lchip-lang" lang={langTag(c.lang)}>{langNative(c.lang)}</span>
                </button>
              ))}
              <span className="select sm"><select aria-label="Another language" value="" onChange={e => { if (e.target.value) void setViewLang(e.target.value); }}>
                <option value="">Other…</option>{OUT_LANGS.map(l => <option key={l.code} value={l.code}>{l.native}</option>)}</select><Icon n="down" size={14} /></span>
            </div>
            <Seg small label="Caption layout" value={L.display} onChange={v => setState(s => ({ live: s.live ? { ...s.live, display: v } : s.live }))}
              options={[{ value: 'both', label: 'Both' }, { value: 'tr', label: 'Translated' }, { value: 'orig', label: 'Original' }]} />
          </div>
        </header>
        <div className="live-tabs"><Seg label="Live view" value={tab} onChange={setTab} options={[{ value: 'captions', label: 'Captions' }, { value: 'clarity', label: 'Clarity' }]} /></div>
        <Transcript L={L} partial={partial} myLang={myLang} />
      </section>
      <aside className="clarity-rail" aria-label="Clarity">
        <div className="clarity">
          <div className="cl-head"><Mascot state={mascot} size={56} /><div><h2 className="h3">Clarity</h2><p className="muted sm">{L.status === 'ended' ? 'Final notes' : 'Updates while people talk'}</p></div></div>
          {L.status === 'live' && <button className="btn sm" disabled={L.clarityState === 'working' || !L.lines.length} onClick={() => void api.session.summarize()}><Icon n="sparkle" />{L.clarityState === 'working' ? 'Bibbly is thinking…' : 'Refresh notes'}</button>}
          {L.clarityState === 'error' && <p className="hint">{L.clarityMessage}</p>}
          {L.clarity ? <ClarityBody cl={L.clarity} lang={L.viewLang} note={{ id: L.noteId ?? L.id, languages: [...new Set(L.lines.map(l => l.lang))] }} /> : <p className="cl-empty">Bibbly is listening for decisions and to-dos…</p>}
          {L.room && <RoomPanel room={L.room} />}
        </div>
      </aside>
    </div>
  );
}

function Transcript({ L, partial, myLang }: { L: LiveView; partial: PartialLine | null; myLang: LangCode }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const arrived = useRef(new Map<string, number>());
  for (const l of L.lines) if (!arrived.current.has(l.id)) arrived.current.set(l.id, Date.now());
  useEffect(() => { const el = ref.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [L.lines.length, partial?.text, L.viewLang, L.status]);
  return (
    <div className="transcript" ref={ref} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90; }}>
      {L.viewLang !== myLang && <div className="viewas-note"><Icon n="users" size={15} />Showing what someone reading {langNative(L.viewLang)} sees. <button className="link" onClick={() => void setViewLang(myLang)}>Back to mine</button></div>}
      {!L.lines.length && !partial && <Empty state="listen" title="Bibbly is listening…">Captions appear here as soon as someone speaks.</Empty>}
      {L.lines.map(l => <Caption key={l.id} line={l} lang={L.viewLang} display={L.display} age={Date.now() - (arrived.current.get(l.id) ?? 0)} />)}
      {partial && <PartialCaption p={partial} />}
      {L.status === 'ended' && (
        <div className="endcard">
          <Mascot state="happy" size={76} />
          <div className="endcard-text"><h2 className="h3">That’s a wrap</h2><p>{L.lines.length} lines in {[...new Set(L.lines.flatMap(l => l.langs ?? [l.lang]))].map(langNative).join(', ')}.{L.clarity ? ` Bibbly found ${L.clarity.actions.length} action items.` : ''}</p></div>
          <div className="endcard-actions">{L.noteId && <button className="btn primary" onClick={() => go('notes', { noteId: L.noteId ?? null })}><Icon n="notes" />Open the note</button>}<button className="btn ghost" onClick={closeLive}>New session</button></div>
        </div>
      )}
    </div>
  );
}

export function Caption({ line, lang, display, age = 99_999 }: { line: Line; lang: LangCode; display: 'both' | 'tr' | 'orig'; age?: number }) {
  const g = lineText(line, lang);
  const dir = (c: LangCode) => (isRtl(c) ? 'rtl' : undefined);
  let body;
  if (g.same || display === 'orig') body = <p className="cap-main" lang={langTag(line.lang)} dir={dir(line.lang)}>{line.text}</p>;
  else if (g.missing) {
    body = (
      <>
        <p className={display === 'tr' ? 'cap-main' : 'cap-src'} lang={langTag(line.lang)} dir={dir(line.lang)}>{line.text}</p>
        {age < 12_000
          ? <p className="cap-main pending" aria-label="Translating"><span className="shimmer" /><span className="shimmer short" /></p>
          : <p className="cap-note">Not translated into {langNative(lang)} yet. <button className="link" onClick={() => void api.session.retry(line.id, lang)}>Retry</button></p>}
      </>
    );
  } else {
    body = (
      <>
        <p className="cap-main" lang={langTag(lang)} dir={dir(lang)}>{g.text}</p>
        {display === 'both' && <p className="cap-src" lang={langTag(line.lang)} dir={dir(line.lang)}>{line.text}</p>}
      </>
    );
  }
  return (
    <article className={`cap${line.speaker.self ? ' cap--me' : ''}`}>
      <Avatar name={line.speaker.name} color={speakerColor(line.speaker.id, line.speaker.self)} />
      <div className="cap-body">
        <div className="cap-meta"><span className="cap-who">{line.speaker.name}</span><span className="cap-time tnum">{fmtClock(line.t)}</span><LangChip line={line} /></div>
        {body}
      </div>
    </article>
  );
}

function PartialCaption({ p }: { p: PartialLine }) {
  return (
    <article className="cap cap--partial">
      <Avatar name={p.speaker.name} color={speakerColor(p.speaker.id, p.speaker.self)} />
      <div className="cap-body">
        <div className="cap-meta"><span className="cap-who">{p.speaker.name}</span><LangChip line={{ lang: p.lang ?? 'en' }} detecting={!p.lang} /></div>
        <p className="cap-src live" lang={p.lang ? langTag(p.lang) : undefined}>{p.text}<span className="caret" aria-hidden="true" /></p>
      </div>
    </article>
  );
}

export function ClarityBody({ cl, lang, note }: { cl: Clarity; lang: LangCode; note: Pick<Note, 'id' | 'languages'> }) {
  const { data } = useApp();
  const tx = (it: { src: LangCode; text: Record<LangCode, string> }) => { const r = itemText(it, lang); return <span className={r.fallback ? 'fb' : ''} lang={langTag(r.fallback ? it.src : lang)}>{r.text}</span>; };
  const added = (id: string) => !!data?.tasks.some(t => t.source?.actionId === id);
  if (!cl.summary.length && !cl.decisions.length && !cl.actions.length && !cl.followup) return <p className="cl-empty">No notes yet.</p>;
  return (
    <div className="clb">
      {!!cl.summary.length && <section className="clb-sec"><h3 className="clb-h">{clarityLabel(lang, 'summary')}</h3><ul className="clb-list">{cl.summary.map((s, i) => <li key={i}>{tx(s)}</li>)}</ul></section>}
      {!!cl.decisions.length && <section className="clb-sec"><h3 className="clb-h">{clarityLabel(lang, 'decisions')}</h3><ul className="clb-list dec">{cl.decisions.map((s, i) => <li key={i}><Icon n="tick" size={15} />{tx(s)}</li>)}</ul></section>}
      {!!cl.actions.length && (
        <section className="clb-sec"><h3 className="clb-h">{clarityLabel(lang, 'actions')}</h3>
          <ul className="clb-actions">{cl.actions.map(a => (
            <li key={a.id} className="act">
              <Avatar name={a.owner} color={speakerColor(a.owner, a.ownerIsMe)} size={28} />
              <div className="act-body"><span className="act-owner">{a.ownerIsMe ? 'You' : a.owner}</span><span className="act-text">{tx(a)}</span><DueChip due={a.due} /></div>
              <button className={`icon-btn sm add${added(a.id) ? ' done' : ''}`} aria-label={added(a.id) ? 'Already in your tasks' : 'Add to my tasks'} title={added(a.id) ? 'In your tasks' : 'Add to my tasks'} onClick={() => addActionAsTask(a, note, lang)}><Icon n={added(a.id) ? 'tick' : 'plus'} size={16} /></button>
            </li>))}</ul>
        </section>
      )}
      {cl.followup && (
        <section className="clb-sec"><h3 className="clb-h">{clarityLabel(lang, 'followup')}</h3>
          <div className="clb-event"><span className="ev-ic"><Icon n="calendar" /></span><div className="ev-txt"><b>{tx(cl.followup)}</b><span>{cl.followup.when ? `${relDay(cl.followup.when)} · ${fmtTime(cl.followup.when)}` : 'Time not agreed yet'}</span></div>
            <button className="btn sm" onClick={() => addFollowUp(cl.followup!, note, lang)}>Add to calendar</button></div>
        </section>
      )}
    </div>
  );
}

function RoomPanel({ room }: { room: NonNullable<LiveView['room']> }) {
  const [qr, setQr] = useState<string>('');
  useEffect(() => { void QRCode.toDataURL(room.joinUrl, { margin: 1, width: 180 }).then(setQr); }, [room.joinUrl]);
  const listeners = useMemo(() => room.members.filter(m => m.role === 'listener'), [room.members]);
  return (
    <section className="room-panel">
      <h3 className="clb-h">Room {room.code}</h3>
      {qr && <img className="qr" src={qr} alt={`QR code for ${room.joinUrl}`} width={150} height={150} />}
      <p className="sm"><span className="selectable">{room.joinUrl}</span> <button className="link" onClick={() => { void navigator.clipboard.writeText(room.joinUrl); }}>Copy</button></p>
      <p className="muted sm">{room.connected ? `${listeners.length} following` : 'Connecting to the rooms server…'}</p>
      <ul className="peers">{listeners.map(m => <li key={m.id} className="peer"><Avatar name={m.name} color={speakerColor(m.id)} size={24} /><span className="peer-name">{m.name}</span><span className="chip sm">{langNative(m.lang)}</span></li>)}</ul>
    </section>
  );
}
