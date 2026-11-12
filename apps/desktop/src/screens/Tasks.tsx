import { useState } from 'react';
import { dayDiff, hasTime, isoDay, pad2, parseQuickTask, type Task, type TaskList } from '@bibbly/core';
import { addTask, deleteTask, go, toast, toggleTask, updateTask, useApp } from '../store';
import { DueChip, Empty, Seg, Sheet, Toggle, relDay, fmtTime } from '../ui/bits';
import { Icon } from '../ui/Icon';
import { Mascot } from '../ui/Mascot';

export const LIST_COLORS: Record<TaskList, string> = { Work: 'var(--lagoon)', Personal: 'var(--coral-fill)', Home: 'var(--sun)' };
const FILTERS = [
  { id: 'today', label: 'Today', pick: (t: Task) => !t.done && !!t.due && dayDiff(t.due) <= 0 },
  { id: 'upcoming', label: 'Upcoming', pick: (t: Task) => !t.done && !!t.due && dayDiff(t.due) > 0 },
  { id: 'meetings', label: 'From meetings', pick: (t: Task) => !t.done && !!t.source },
  { id: 'reminders', label: 'Reminders', pick: (t: Task) => !t.done && t.remind },
  { id: 'someday', label: 'Someday', pick: (t: Task) => !t.done && !t.due },
  { id: 'done', label: 'Done', pick: (t: Task) => t.done },
] as const;

export function TasksScreen() {
  const { data } = useApp();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('today');
  const [editing, setEditing] = useState<string | null>(null);
  if (!data) return null;
  const f = FILTERS.find(x => x.id === filter)!;
  const list = data.tasks.filter(f.pick).sort((a, b) => (filter === 'done' ? (b.doneAt ?? 0) - (a.doneAt ?? 0) : (a.due ?? 9e15) - (b.due ?? 9e15)));
  const groups = new Map<string, Task[]>();
  for (const t of list) {
    const key = filter === 'done' ? 'Completed' : !t.due ? 'No date' : dayDiff(t.due) < 0 ? 'Overdue' : relDay(t.due);
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const todayCount = data.tasks.filter(FILTERS[0].pick).length;
  const task = editing ? data.tasks.find(t => t.id === editing) : null;
  return (
    <div className="page tasks">
      <header className="page-head"><div><h1 className="h1">Tasks</h1><p className="lede">Your to-dos and reminders, including everything you agreed to in meetings.</p></div><Mascot state={todayCount ? 'idle' : 'happy'} size={80} /></header>
      <QuickAdd />
      <div className="filters" role="tablist" aria-label="Task lists">
        {FILTERS.map(x => <button key={x.id} role="tab" aria-selected={filter === x.id} className={`fchip${filter === x.id ? ' on' : ''}`} onClick={() => setFilter(x.id)}>{x.label}<span className="fcount tnum">{data.tasks.filter(x.pick).length}</span></button>)}
      </div>
      {[...groups.entries()].map(([title, items]) => (
        <section className="tgroup" key={title}><h2 className={`tg-title${title === 'Overdue' ? ' late' : ''}`}>{title}</h2>
          <ul className="tlist">{items.map(t => <li key={t.id}><TaskRow t={t} onOpen={() => setEditing(t.id)} /></li>)}</ul></section>
      ))}
      {!list.length && <Empty state={filter === 'today' ? 'happy' : 'sleep'} title={filter === 'today' ? 'All clear for today.' : 'Nothing here yet.'}>{filter === 'today' ? 'Bibbly adds anything new from your meetings.' : 'Add a task above, or let Bibbly pull to-dos from your meetings.'}</Empty>}
      {task && <TaskSheet t={task} onClose={() => setEditing(null)} />}
    </div>
  );
}

export function TaskRow({ t, onOpen }: { t: Task; onOpen: () => void }) {
  const { data } = useApp();
  const note = t.source ? data?.notes.find(n => n.id === t.source!.noteId) : undefined;
  const c = LIST_COLORS[t.list];
  return (
    <div className={`task${t.done ? ' done' : ''}`}>
      <button className="tcheck" role="checkbox" aria-checked={t.done} aria-label={`${t.done ? 'Mark as not done' : 'Mark as done'}: ${t.title}`} onClick={() => toggleTask(t.id)} style={{ ['--c' as string]: c }}><Icon n="tick" size={14} /></button>
      <button className="tmain" onClick={onOpen}>
        <span className="ttitle">{t.title}</span>
        <span className="tmeta">
          <DueChip due={t.due} done={t.done} />
          {t.remind && <span className="chip"><Icon n="bell" size={12} />Reminder</span>}
          <span className="chip"><span className="dot" style={{ ['--c' as string]: c }} />{t.list}</span>
          {t.repeat && <span className="chip"><Icon n="refresh" size={12} />{t.repeat}</span>}
          {note && <span className="chip from"><Icon n="mic" size={12} />{note.title.split(':')[0]}</span>}
        </span>
      </button>
    </div>
  );
}

export function QuickAdd({ compact }: { compact?: boolean }) {
  const [v, setV] = useState('');
  const p = v.trim() ? parseQuickTask(v) : null;
  return (
    <form className={`quick${compact ? ' compact' : ''}`} onSubmit={e => { e.preventDefault(); const t = addTask(v); if (t) { setV(''); toast(`Added “${t.title}”${t.due ? ` for ${relDay(t.due).toLowerCase()}` : ''}.`, { mascot: 'happy' }); } }}>
      <div className="quick-row">
        <Icon n="plus" />
        <input className="quick-input" aria-label="New task" autoComplete="off" value={v} onChange={e => setV(e.target.value)}
          placeholder={compact ? 'Add a task…' : 'Add a task, e.g. “Send deck to Li Wei tomorrow 3pm”'} />
        <button className="btn primary sm" type="submit" disabled={!v.trim()}>Add</button>
      </div>
      {p ? (
        <div className="quick-preview" aria-live="polite">
          {p.due ? <span className="chip"><Icon n="calendar" size={12} />{relDay(p.due)}{hasTime(p.due) ? ` ${fmtTime(p.due)}` : ''}</span> : <span className="chip">No date</span>}
          {p.remind && <span className="chip"><Icon n="bell" size={12} />Reminder</span>}
          <span className="chip"><span className="dot" style={{ ['--c' as string]: LIST_COLORS[p.list] }} />{p.list}</span><span className="qp-title">{p.title}</span>
        </div>
      ) : !compact && <p className="hint">Bibbly understands “tomorrow 3pm”, “Fri”, “tonight”, “in 3 days” and #work, #home or #personal. Other languages work too with a Claude key, e.g. “明天下午三点给李伟发报价”.</p>}
    </form>
  );
}

function TaskSheet({ t, onClose }: { t: Task; onClose: () => void }) {
  const { data } = useApp();
  const note = t.source ? data?.notes.find(n => n.id === t.source!.noteId) : undefined;
  const line = note && t.source?.lineId ? note.lines.find(l => l.id === t.source!.lineId) : undefined;
  const day = t.due ? isoDay(t.due) : '';
  const time = t.due && hasTime(t.due) ? `${pad2(new Date(t.due).getHours())}:${pad2(new Date(t.due).getMinutes())}` : '';
  const setDue = (d: string, tm: string) => {
    const base = d ? new Date(`${d}T00:00:00`) : null;
    if (base && tm) { const [h, m] = tm.split(':').map(Number); base.setHours(h ?? 0, m ?? 0); }
    updateTask(t.id, { due: base ? base.getTime() : null, remind: !!(d && tm) && t.remind });
  };
  return (
    <Sheet title="Task" onClose={onClose}>
      <div className="field"><label htmlFor="ts-title">Title</label><input id="ts-title" className="input" value={t.title} onChange={e => updateTask(t.id, { title: e.target.value })} /></div>
      <div className="field-row">
        <div className="field"><label htmlFor="ts-day">Due date</label><input id="ts-day" className="input" type="date" value={day} onChange={e => setDue(e.target.value, time)} /></div>
        <div className="field"><label htmlFor="ts-time">Time</label><input id="ts-time" className="input" type="time" value={time} disabled={!day} onChange={e => setDue(day, e.target.value)} /></div>
      </div>
      <div className="row-between"><span>Remind me{time ? ` at ${fmtTime(t.due!)}` : ''}</span><Toggle on={t.remind} onChange={v => (time ? updateTask(t.id, { remind: v }) : toast('Add a time first to get a reminder.'))} label="Remind me" /></div>
      <div className="field"><span className="flabel">List</span><Seg label="List" value={t.list} onChange={v => updateTask(t.id, { list: v })} options={(['Work', 'Personal', 'Home'] as const).map(k => ({ value: k, label: k }))} /></div>
      {note && (
        <div className="ts-src"><p className="eyebrow">From {note.title}</p>
          {line && <blockquote><span className="tsq-who">{line.speaker.name}</span><span>{line.text}</span>{line.tr[data!.settings.myLang] && <span className="tsq-tr">{line.tr[data!.settings.myLang]}</span>}</blockquote>}
          <button className="link" onClick={() => { onClose(); go('notes', { noteId: note.id }); }}>Open the note<Icon n="right" size={15} /></button>
        </div>
      )}
      <div className="sheet-actions">
        <button className="btn ghost" onClick={() => { deleteTask(t.id); onClose(); }}><Icon n="trash" />Delete</button>
        <button className="btn primary" onClick={() => { toggleTask(t.id); onClose(); }}><Icon n="tick" />{t.done ? 'Mark not done' : 'Mark done'}</button>
      </div>
    </Sheet>
  );
}
