import { useEffect } from 'react';
import { langNative } from '@bibbly/core';
import { go, setState, useApp, type Route } from './store';
import { Icon } from './ui/Icon';
import { Mascot, type MascotState } from './ui/Mascot';
import { CalendarScreen } from './screens/Calendar';
import { LiveScreen } from './screens/Live';
import { NotesScreen } from './screens/Notes';
import { SettingsScreen } from './screens/Settings';
import { StickScreen } from './screens/Stick';
import { TasksScreen } from './screens/Tasks';
import { TodayScreen } from './screens/Today';

const NAV: { id: Route; label: string; icon: string }[] = [
  { id: 'today', label: 'Today', icon: 'sun' },
  { id: 'live', label: 'Live', icon: 'mic' },
  { id: 'notes', label: 'Notes', icon: 'notes' },
  { id: 'tasks', label: 'Tasks', icon: 'check' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
];
const NAV2: { id: Route; label: string; icon: string }[] = [
  { id: 'stick', label: 'Bibbly Stick', icon: 'usb' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];
const SCREENS: Record<Route, () => React.JSX.Element | null> = {
  today: TodayScreen, live: LiveScreen, notes: NotesScreen, tasks: TasksScreen, calendar: CalendarScreen, stick: StickScreen, settings: SettingsScreen,
};

export function App() {
  const s = useApp();
  useEffect(() => {
    const onHash = () => { const r = location.hash.slice(1) as Route; if (r in SCREENS && r !== s.route) setState({ route: r }); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [s.route]);
  if (!s.data) return <div className="boot"><Mascot state="sleep" size={96} /><p>Bibbly is waking up…</p></div>;
  const Screen = SCREENS[s.route];
  const live = s.live?.status === 'live';
  const mascot: MascotState = live ? 'listen' : 'idle';
  const dueToday = s.data.tasks.filter(t => !t.done && t.due && t.due < new Date().setHours(23, 59, 59, 999)).length;
  const navBtn = (n: { id: Route; label: string; icon: string }) => (
    <button key={n.id} className={`nav-i${s.route === n.id ? ' on' : ''}`} aria-current={s.route === n.id ? 'page' : undefined} onClick={() => go(n.id)}>
      <Icon n={n.icon} /><span>{n.label}</span>
      {n.id === 'live' && live && <span className="rec-dot" title="Session running" />}
      {n.id === 'tasks' && dueToday > 0 && <span className="nav-count">{dueToday}</span>}
    </button>
  );
  return (
    <div className="app">
      <div className="shell">
        <aside className="side">
          <div className="brand"><Mascot state={mascot} size={44} /><span className="brand-name">Bibbly</span></div>
          <nav className="nav" aria-label="Main">{NAV.map(navBtn)}<p className="nav-label">Device and setup</p>{NAV2.map(navBtn)}</nav>
          <div className="side-foot"><button className="lang-pill" onClick={() => go('settings')}><Icon n="globe" /><span>Captions in <b>{langNative(s.data.settings.myLang)}</b></span></button></div>
        </aside>
        <header className="topbar"><div className="topbar-in">
          <Mascot state={mascot} size={34} /><span className="topbar-title">{[...NAV, ...NAV2].find(n => n.id === s.route)?.label}</span>
          <button className="icon-btn" aria-label="Settings" onClick={() => go('settings')}><Icon n="settings" /></button>
        </div></header>
        <main className={`main${s.route === 'live' && s.live ? ' main--fixed' : ''}${s.route === 'notes' ? ' main--notes' : ''}`}><Screen /></main>
        <nav className="tabs" aria-label="Main"><div className="tabs-in">
          {[NAV[0]!, NAV[2]!, NAV[1]!, NAV[3]!, NAV[4]!].map(n => n.id === 'live'
            ? <button key={n.id} className={`tab-live${live ? ' rec' : ''}`} aria-label="Live" onClick={() => go('live')}><Icon n="mic" size={24} /></button>
            : <button key={n.id} className={`tab${s.route === n.id ? ' on' : ''}`} onClick={() => go(n.id)}><Icon n={n.icon} size={21} /><span>{n.label}</span></button>)}
        </div></nav>
      </div>
      {s.toast && (
        <div className="toast" role="status">
          {s.toast.mascot && <Mascot state={s.toast.mascot} size={34} />}
          <span className="toast-text">{s.toast.text}</span>
          {s.toast.action && <button className="btn sm" onClick={() => { const a = s.toast!.action!; setState({ toast: null }); a.run(); }}>{s.toast.action.label}</button>}
          <button className="icon-btn sm" aria-label="Dismiss" onClick={() => setState({ toast: null })}><Icon n="x" size={15} /></button>
        </div>
      )}
    </div>
  );
}
