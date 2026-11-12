import { useEffect, useRef, type ReactNode } from 'react';
import { dayDiff, detectedLabel, hasTime, LANGUAGES, type LangCode, type Line } from '@bibbly/core';
import { Icon } from './Icon';
import { Mascot, type MascotState } from './Mascot';

export const OUT_LANGS = LANGUAGES.filter(l => l.code !== 'yue');
export const initials = (name: string) => (name || '?').replace(/^(Mr\.|Ms\.|Dr\.)\s*/, '').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
export const pluralize = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
export const fmtTime = (d: number) => new Date(d).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
export const fmtDate = (d: number) => new Date(d).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' });
export function relDay(d: number): string {
  const n = dayDiff(d);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n > 1 && n < 7) return new Date(d).toLocaleDateString('en', { weekday: 'long' });
  return fmtDate(d);
}

const COLORS = ['var(--sp-li)', 'var(--sp-jun)', 'var(--sp-sato)', 'var(--sp-x)'];
export function speakerColor(id: string, self?: boolean): string {
  if (self) return 'var(--sp-you)';
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

export function Avatar({ name, color, size = 34 }: { name: string; color: string; size?: number }) {
  return <span className="av" style={{ ['--c' as string]: color, width: size, height: size, fontSize: Math.round(size * 0.38) }} aria-hidden="true">{initials(name)}</span>;
}

export function Toggle({ on, onChange, label, id }: { on: boolean; onChange: (v: boolean) => void; label: string; id?: string }) {
  return <button id={id} type="button" className={`switch${on ? ' on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}><span className="knob" /></button>;
}

export function Seg<T extends string>({ value, options, onChange, label, small }: { value: T; options: { value: T; label: string; icon?: string; disabled?: boolean }[]; onChange: (v: T) => void; label: string; small?: boolean }) {
  return (
    <div className={`seg${small ? ' sm' : ''}`} role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} disabled={o.disabled} onClick={() => onChange(o.value)}>
          {o.icon && <Icon n={o.icon} size={15} />}{o.label}
        </button>
      ))}
    </div>
  );
}

export function LangSelect({ value, onChange, id, label }: { value: LangCode; onChange: (v: LangCode) => void; id?: string; label: string }) {
  return (
    <span className="select">
      <select id={id} aria-label={label} value={value} onChange={e => onChange(e.target.value)}>
        {OUT_LANGS.map(l => <option key={l.code} value={l.code}>{l.native}{l.native !== l.name ? ` · ${l.name}` : ''}</option>)}
      </select>
      <Icon n="down" size={16} />
    </span>
  );
}

export function LangChip({ line, detecting }: { line: Pick<Line, 'lang' | 'langs' | 'confidence'>; detecting?: boolean }) {
  if (detecting) return <span className="chip lang detecting"><span className="pulse" />Detecting language</span>;
  const mixed = !!line.langs && line.langs.length > 1;
  return (
    <span className={`chip lang${mixed ? ' mixed' : ''}`} title="Detected automatically">
      {detectedLabel(line.lang, line.langs)}
      {line.confidence != null && <span className="conf">{Math.round(line.confidence * 100)}%</span>}
      {mixed && <span className="conf">mixed</span>}
    </span>
  );
}

export function DueChip({ due, done }: { due: number | null; done?: boolean }) {
  if (!due) return null;
  const n = dayDiff(due);
  const late = !done && (n < 0 || (n === 0 && hasTime(due) && due < Date.now()));
  return <span className={`chip due${late ? ' late' : n === 0 ? ' today' : ''}`}><Icon n="clock" size={12} />{relDay(due)}{hasTime(due) ? ` ${fmtTime(due)}` : ''}</span>;
}

export function Empty({ state = 'idle', title, children }: { state?: MascotState; title: string; children?: ReactNode }) {
  return <div className="empty"><Mascot state={state} size={84} /><p className="empty-title">{title}</p>{children && <p className="empty-sub">{children}</p>}</div>;
}

export function Sheet({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('.sheet-body input, .sheet-body select, .sheet-body textarea, .sheet-body button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="scrim" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`sheet${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="sheet-head"><h2 className="h3">{title}</h2><button className="icon-btn" aria-label="Close" onClick={onClose}><Icon n="x" /></button></div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
