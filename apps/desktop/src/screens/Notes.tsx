import { useEffect, useState } from 'react';
import { exportModel, itemText, langNative, lineText, spokenName, toMarkdown, type ExportFormat, type LangCode, type Note } from '@bibbly/core';
import { deleteNote, exportNote, setState, toast, translateNote, useApp } from '../store';
import { Empty, LangSelect, Seg, fmtDate, fmtTime, relDay } from '../ui/bits';
import { Icon } from '../ui/Icon';
import { Caption, ClarityBody } from './Live';

const FORMATS: { id: ExportFormat; ext: string; name: string; for: string }[] = [
  { id: 'docx', ext: '.docx', name: 'Word document', for: 'Teams, Google Docs, Lark Docs' },
  { id: 'md', ext: '.md', name: 'Markdown', for: 'Notion, Slack, Lark' },
  { id: 'txt', ext: '.txt', name: 'Plain text', for: 'Email or any notes app' },
  { id: 'subtitles-zip', ext: '.srt + .vtt', name: 'Subtitles', for: 'Zoom recordings, video editors' },
  { id: 'json', ext: '.json', name: 'JSON', for: 'Developers and automations' },
  { id: 'all-zip', ext: '.zip', name: 'Everything', for: 'All formats in one file' },
];

export function NotesScreen() {
  const { data, noteId } = useApp();
  const [q, setQ] = useState('');
  if (!data) return null;
  const notes = [...data.notes].sort((a, b) => b.startedAt - a.startedAt);
  const needle = q.trim().toLowerCase();
  const list = needle ? notes.filter(n => `${n.title} ${n.lines.map(l => `${l.text} ${Object.values(l.tr).join(' ')}`).join(' ')}`.toLowerCase().includes(needle)) : notes;
  const sel = noteId ? data.notes.find(n => n.id === noteId) ?? null : null;
  const shown = sel ?? list[0] ?? null;
  return (
    <div className={`notes${sel ? ' has-sel' : ''}`}>
      <section className="notes-list">
        <div className="nl-head">
          <h1 className="h1">Notes</h1>
          <p className="lede">Every meeting and memo, translated and searchable in any language.</p>
          <div className="search"><Icon n="search" /><input type="search" placeholder="Search notes, e.g. 包装 or pricing" value={q} onChange={e => setQ(e.target.value)} aria-label="Search notes" /></div>
        </div>
        <ul className="nl">{list.map(n => (
          <li key={n.id}>
            <button className={`note-row${shown?.id === n.id ? ' on' : ''}`} onClick={() => setState({ noteId: n.id })}>
              <span className="nr-top"><span className="nr-title">{n.title}</span><span className="nr-date">{relDay(n.startedAt)}</span></span>
              <span className="nr-meta"><span>{Math.max(1, Math.round(n.durationSec / 60))} min · {n.source}</span></span>
              {n.clarity?.summary[0] && <span className="nr-snip">{itemText(n.clarity.summary[0], data.settings.myLang).text}</span>}
              <span className="nr-foot">{n.languages.map(l => <span key={l} className="chip sm">{spokenName(l)}</span>)}{n.pendingReason && <span className="chip sm due late">Not transcribed</span>}</span>
            </button>
          </li>))}</ul>
        {!list.length && <Empty state="think" title={needle ? 'No notes match that search.' : 'No notes yet.'}>{needle ? null : 'Save a live session and it lands here.'}</Empty>}
      </section>
      <section className="notes-detail">{shown ? <NoteDetail key={shown.id} note={shown} /> : <Empty title="No notes yet">Save a live session and it lands here.</Empty>}</section>
    </div>
  );
}

function NoteDetail({ note }: { note: Note }) {
  const { data } = useApp();
  const myLang = data!.settings.myLang;
  const [lang, setLang] = useState<LangCode>(myLang);
  const [tab, setTab] = useState<'clarity' | 'transcript' | 'export'>('clarity');
  const [orig, setOrig] = useState(true);
  const [withClarity, setWithClarity] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const missing = note.lines.some(l => lineText(l, lang).missing);
  useEffect(() => {
    if (!missing) return;
    setBusy(true);
    void translateNote(note.id, lang).finally(() => setBusy(false));
  }, [lang, note.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const copyMd = async () => {
    const md = toMarkdown(exportModel(note, lang, { original: orig, clarity: withClarity, myName: data!.settings.myName }));
    try { await navigator.clipboard.writeText(md); toast('Markdown copied. Paste it into Notion, Slack or Lark.'); }
    catch { toast('Copy did not work here. Use the Markdown download instead.'); }
  };
  return (
    <article className="note">
      <button className="back link" onClick={() => setState({ noteId: null })}><Icon n="left" size={16} />All notes</button>
      <header className="note-head">
        <h2 className="h2">{note.title}</h2>
        <p className="note-meta">{fmtDate(note.startedAt)} · {fmtTime(note.startedAt)} · {Math.max(1, Math.round(note.durationSec / 60))} min · {note.source}</p>
        <div className="note-langs">
          <span className="muted">Spoken</span>{note.languages.map(l => <span key={l} className="chip sm">{spokenName(l)}</span>)}
          <span className="muted nl-read">Read in</span><LangSelect id="note-lang" value={lang} onChange={setLang} label="Read this note in" />
          {busy && <span className="chip sm"><span className="pulse" />Translating</span>}
        </div>
        <Seg label="Note sections" value={tab} onChange={setTab} options={[{ value: 'clarity', label: 'Clarity' }, { value: 'transcript', label: 'Transcript' }, { value: 'export', label: 'Export & share' }]} />
      </header>
      {note.pendingReason && <div className="notice warn"><Icon n="info" />This recording is saved but not transcribed yet: {note.pendingReason}</div>}
      {tab === 'clarity' && <div className="note-sec">{note.clarity ? <ClarityBody cl={note.clarity} lang={lang} note={note} /> : <p className="muted">No notes for this recording yet.</p>}</div>}
      {tab === 'transcript' && <div className="note-sec transcript static">{note.lines.map(l => <Caption key={l.id} line={l} lang={lang} display="both" />)}{!note.lines.length && <p className="muted">No transcript yet.</p>}</div>}
      {tab === 'export' && (
        <div className="note-sec export">
          <div className="ex-opts">
            <label className="check-row"><input type="checkbox" checked={orig} onChange={e => setOrig(e.target.checked)} />Include the original language under each line</label>
            <label className="check-row"><input type="checkbox" checked={withClarity} onChange={e => setWithClarity(e.target.checked)} />Include the summary, decisions and action items</label>
            <p className="hint">Files are written in <b>{langNative(lang)}</b>. Change “Read in” above to export another language.</p>
          </div>
          <h3 className="h4">Download a file</h3>
          <div className="ex-grid">{FORMATS.map(f => (
            <button key={f.id} className="ex-file" onClick={() => void exportNote(note.id, f.id, lang, { original: orig, clarity: withClarity })}>
              <span className="ext">{f.ext}</span><span className="ex-name">{f.name}</span><span className="ex-for">{f.for}</span>
            </button>))}</div>
          <div className="ex-copy"><button className="btn" onClick={() => void copyMd()}><Icon n="copy" />Copy as Markdown</button><span className="hint">Pastes cleanly into Notion, Slack and Lark.</span></div>
          <div className="danger-zone">
            {confirmDelete
              ? <><span>Delete this note and its transcript? This can’t be undone.</span><button className="btn danger" onClick={() => void deleteNote(note.id)}>Delete note</button><button className="btn ghost" onClick={() => setConfirmDelete(false)}>Keep it</button></>
              : <button className="btn ghost" onClick={() => setConfirmDelete(true)}><Icon n="trash" />Delete note</button>}
          </div>
        </div>
      )}
    </article>
  );
}
