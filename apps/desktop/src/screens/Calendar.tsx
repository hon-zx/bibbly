import { useState } from 'react';
import { addDays, atTime, hasTime, isoDay, sameDay, spokenName, uid, weekStart, type CalendarEvent, type Platform } from '@bibbly/core';
import { go, saveEvents, useApp } from '../store';
import { Sheet, Toggle, fmtTime, relDay } from '../ui/bits';
import { Icon } from '../ui/Icon';

const PLATFORMS: Record<Platform, string> = { zoom: 'Zoom', teams: 'Microsoft Teams', meet: 'Google Meet', lark: 'Lark', 'in-person': 'In person', other: 'Other' };

export function CalendarScreen() {
  const { data } = useApp();
  const [week, setWeek] = useState(0);
  const [adding, setAdding] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return null;
  const start = addDays(weekStart(Date.now()), week * 7);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const range = `${days[0]!.toLocaleDateString('en', { month: 'short', day: 'numeric' })} – ${days[6]!.toLocaleDateString('en', { month: 'short', day: 'numeric' })}`;
  const ev = open ? data.events.find(e => e.id === open) : null;
  return (
    <div className="page cal">
      <header className="page-head cal-head">
        <div><h1 className="h1">Calendar</h1><p className="lede">Meetings Bibbly joins and translates, follow-ups from your notes, and tasks with a due date.</p></div>
        <div className="cal-ctrl">
          <button className="icon-btn" aria-label="Previous week" onClick={() => setWeek(week - 1)}><Icon n="left" /></button>
          <span className="cal-range tnum">{range}</span>
          <button className="icon-btn" aria-label="Next week" onClick={() => setWeek(week + 1)}><Icon n="right" /></button>
          <button className="btn sm" onClick={() => setWeek(0)}>This week</button>
          <button className="btn primary sm" onClick={() => setAdding(isoDay(Date.now()))}><Icon n="plus" />Event</button>
        </div>
      </header>
      <div className="agenda-week">
        {days.map(d => {
          const evs = data.events.filter(e => sameDay(e.start, d)).sort((a, b) => a.start - b.start);
          const due = data.tasks.filter(t => t.due && !t.done && sameDay(t.due, d));
          const today = sameDay(d, Date.now());
          return (
            <section key={isoDay(d)} className={`aw-day${today ? ' today' : ''}`}>
              <h2 className="aw-head"><span>{d.toLocaleDateString('en', { weekday: 'short' })}</span><b className="tnum">{d.getDate()}</b>{today && <span className="chip sm">Today</span>}
                <button className="icon-btn sm" aria-label={`Add an event on ${d.toDateString()}`} onClick={() => setAdding(isoDay(d))}><Icon n="plus" size={15} /></button></h2>
              <ul className="da-list">
                {evs.map(e => (
                  <li key={e.id}><button className="da-ev" onClick={() => setOpen(e.id)}>
                    <span className="da-time tnum">{fmtTime(e.start)}<small>{e.durationMin} min</small></span>
                    <span className="da-body"><b>{e.title}</b><span>{PLATFORMS[e.platform]}{e.languages?.length ? ` · ${e.languages.map(spokenName).join(', ')}` : ''}{e.bibblyJoins ? ' · Bibbly translates' : ''}</span></span>
                  </button></li>
                ))}
                {due.map(t => <li key={t.id}><button className="da-task" onClick={() => go('tasks')}><Icon n="check" size={16} /><span><b>{t.title}</b><span>Due{t.due && hasTime(t.due) ? ` ${fmtTime(t.due)}` : ''}</span></span></button></li>)}
                {!evs.length && !due.length && <li className="muted sm">Nothing planned.</li>}
              </ul>
            </section>
          );
        })}
      </div>
      {adding && <NewEvent day={adding} onClose={() => setAdding(null)} />}
      {ev && <EventSheet e={ev} onClose={() => setOpen(null)} />}
    </div>
  );
}

function NewEvent({ day, onClose }: { day: string; onClose: () => void }) {
  const { data } = useApp();
  const [f, setF] = useState({ title: '', day, time: '15:00', dur: 30, platform: 'zoom' as Platform, bibbly: true });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.title.trim()) return;
    const start = atTime(new Date(`${f.day}T00:00:00`), f.time || '09:00').getTime();
    const ev: CalendarEvent = { id: uid('e_'), title: f.title.trim().slice(0, 80), start, durationMin: f.dur, platform: f.platform, bibblyJoins: f.platform !== 'in-person' && f.bibbly, languages: [data!.settings.myLang] };
    saveEvents([...data!.events, ev]);
    onClose();
  };
  return (
    <Sheet title="New event" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="field"><label htmlFor="ne-title">Title</label><input id="ne-title" className="input" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} placeholder="e.g. Supplier call" /></div>
        <div className="field-row">
          <div className="field"><label htmlFor="ne-day">Date</label><input id="ne-day" className="input" type="date" value={f.day} onChange={e => setF({ ...f, day: e.target.value })} /></div>
          <div className="field"><label htmlFor="ne-time">Start</label><input id="ne-time" className="input" type="time" value={f.time} onChange={e => setF({ ...f, time: e.target.value })} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label htmlFor="ne-dur">Length</label><span className="select"><select id="ne-dur" value={f.dur} onChange={e => setF({ ...f, dur: Number(e.target.value) })}>{[15, 30, 45, 60, 90].map(m => <option key={m} value={m}>{m} minutes</option>)}</select><Icon n="down" size={16} /></span></div>
          <div className="field"><label htmlFor="ne-plat">Where</label><span className="select"><select id="ne-plat" value={f.platform} onChange={e => setF({ ...f, platform: e.target.value as Platform })}>{Object.entries(PLATFORMS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><Icon n="down" size={16} /></span></div>
        </div>
        {f.platform !== 'in-person' && <div className="row-between"><span>Bibbly joins and translates</span><Toggle on={f.bibbly} onChange={v => setF({ ...f, bibbly: v })} label="Bibbly joins and translates" /></div>}
        <div className="sheet-actions"><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" type="submit" disabled={!f.title.trim()}>Add event</button></div>
      </form>
    </Sheet>
  );
}

function EventSheet({ e, onClose }: { e: CalendarEvent; onClose: () => void }) {
  const { data } = useApp();
  const prev = e.prevNoteId ? data?.notes.find(n => n.id === e.prevNoteId) : undefined;
  const own = e.noteId ? data?.notes.find(n => n.id === e.noteId) : undefined;
  const update = (p: Partial<CalendarEvent>) => saveEvents(data!.events.map(x => (x.id === e.id ? { ...x, ...p } : x)));
  const upcoming = e.start + e.durationMin * 60_000 > Date.now();
  return (
    <Sheet title={e.title} onClose={onClose}>
      <ul className="ev-meta">
        <li><Icon n="clock" /><span>{relDay(e.start)}, {fmtTime(e.start)} to {fmtTime(e.start + e.durationMin * 60_000)}</span></li>
        <li><Icon n="users" /><span>{PLATFORMS[e.platform]}{e.attendees ? ` · ${e.attendees}` : ''}</span></li>
        {!!e.languages?.length && <li><Icon n="globe" /><span className="chips">{e.languages.map(l => <span key={l} className="chip sm">{spokenName(l)}</span>)}</span></li>}
      </ul>
      {e.platform !== 'in-person' && <div className="row-between"><div><b>Bibbly joins and translates</b><p className="hint">Captions for each person in their own language, then notes for everyone.</p></div><Toggle on={e.bibblyJoins} onChange={v => update({ bibblyJoins: v })} label="Bibbly joins and translates" /></div>}
      {(own ?? prev) && <div className="ev-link"><p className="eyebrow">{own ? 'Bibbly’s notes' : 'Notes from last time'}</p>
        <button className="link-card" onClick={() => { onClose(); go('notes', { noteId: (own ?? prev)!.id }); }}><b>{(own ?? prev)!.title}</b><span>{(own ?? prev)!.clarity?.actions.length ?? 0} action items · open the note</span></button></div>}
      <div className="sheet-actions">
        <button className="btn ghost" onClick={() => { saveEvents(data!.events.filter(x => x.id !== e.id)); onClose(); }}><Icon n="trash" />Delete</button>
        {upcoming && <button className="btn primary" onClick={() => { onClose(); go('live'); }}><Icon n="mic" />Open Live</button>}
      </div>
    </Sheet>
  );
}

