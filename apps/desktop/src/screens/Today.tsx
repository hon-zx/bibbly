import { dayDiff, sameDay, spokenName } from '@bibbly/core';
import { go, useApp } from '../store';
import { fmtTime, relDay } from '../ui/bits';
import { Icon } from '../ui/Icon';
import { Mascot } from '../ui/Mascot';
import { QuickAdd, TaskRow } from './Tasks';

export function TodayScreen() {
  const { data } = useApp();
  if (!data) return null;
  const now = Date.now();
  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const todays = data.events.filter(e => sameDay(e.start, now)).sort((a, b) => a.start - b.start);
  const next = data.events.filter(e => e.start + e.durationMin * 60_000 > now).sort((a, b) => a.start - b.start)[0];
  const due = data.tasks.filter(t => !t.done && t.due && dayDiff(t.due) <= 0).sort((a, b) => (a.due ?? 0) - (b.due ?? 0));
  const reminders = data.tasks.filter(t => t.remind && !t.done && t.due && t.due > now).sort((a, b) => (a.due ?? 0) - (b.due ?? 0)).slice(0, 3);
  const recent = [...data.notes].sort((a, b) => b.startedAt - a.startedAt).slice(0, 3);
  const left = todays.filter(e => e.start > now);
  const brief = `${left.length ? `${left.length} meeting${left.length === 1 ? '' : 's'} left today${left.some(e => e.bibblyJoins) ? ', and I’ll translate them' : ''}.` : 'No more meetings today.'} ${due.length ? `${due.length} task${due.length === 1 ? '' : 's'} due.` : 'Nothing due. Nice.'}`;
  return (
    <div className="page today">
      <section className="hello">
        <div className="hello-text">
          <p className="eyebrow">{new Date().toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          <h1 className="h1">{greet}{data.settings.myName && data.settings.myName !== 'You' ? `, ${data.settings.myName}` : ''}.</h1>
          <p className="speech"><span>{brief}</span></p>
        </div>
        <div className="hello-art"><Mascot state={h >= 23 || h < 6 ? 'sleep' : 'wave'} size={132} /></div>
      </section>
      <div className="today-grid">
        {next && (
          <section className="card next">
            <p className="eyebrow">Up next · {relDay(next.start)} {fmtTime(next.start)}</p>
            <h2 className="h2">{next.title}</h2>
            {!!next.languages?.length && <div className="chips">{next.languages.map(l => <span key={l} className="chip">{spokenName(l)}</span>)}</div>}
            <div className="next-foot"><span className="muted">{next.bibblyJoins ? 'Bibbly will translate this meeting' : 'Bibbly is not joining this one'}</span>
              <button className="btn primary" onClick={() => go('live')}><Icon n="mic" />Open Live</button></div>
          </section>
        )}
        <section className="card today-tasks">
          <div className="card-head"><h2 className="h3">Due today</h2></div>
          <QuickAdd compact />
          <ul className="tlist">{due.slice(0, 6).map(t => <li key={t.id}><TaskRow t={t} onOpen={() => go('tasks')} /></li>)}</ul>
          {!due.length && <p className="muted">All clear. Enjoy it.</p>}
          <button className="link" onClick={() => go('tasks')}>All tasks<Icon n="right" size={15} /></button>
        </section>
        <section className="card reminders">
          <div className="card-head"><h2 className="h3">Reminders</h2><Icon n="bell" /></div>
          <ul className="mini-list">{reminders.map(t => <li key={t.id}><span className="ml-time tnum">{fmtTime(t.due!)}</span><span className="ml-text">{t.title}<small>{relDay(t.due!)}</small></span></li>)}</ul>
          {!reminders.length && <p className="muted">No reminders coming up.</p>}
        </section>
        <section className="card agenda-card">
          <div className="card-head"><h2 className="h3">Today’s agenda</h2><button className="link" onClick={() => go('calendar')}>Calendar<Icon n="right" size={15} /></button></div>
          <ol className="agenda">{todays.map(e => (
            <li key={e.id} className={e.start + e.durationMin * 60_000 < now ? 'past' : ''}><span className="ag-time tnum">{fmtTime(e.start)}</span>
              <button className="ag-body" onClick={() => go('calendar')}><b>{e.title}</b><span>{e.bibblyJoins ? 'Bibbly translating' : ' '}</span></button></li>))}</ol>
          {!todays.length && <p className="muted">Nothing on the calendar today.</p>}
        </section>
        <section className="card recent">
          <div className="card-head"><h2 className="h3">Recent notes</h2><button className="link" onClick={() => go('notes', { noteId: null })}>All notes<Icon n="right" size={15} /></button></div>
          <ul className="recent-list">{recent.map(n => <li key={n.id}><button onClick={() => go('notes', { noteId: n.id })}><b>{n.title}</b><span>{relDay(n.startedAt)} · {n.languages.map(spokenName).join(', ')}</span></button></li>)}</ul>
        </section>
      </div>
    </div>
  );
}
