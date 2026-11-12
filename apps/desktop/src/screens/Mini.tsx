import { useEffect, useState } from 'react';
import { langNative, langTag, lineText, type Line, type PartialLine } from '@bibbly/core';
import { api } from '../api';
import { Icon } from '../ui/Icon';
import { Mascot } from '../ui/Mascot';

/** Always-on-top caption strip that floats over Zoom, Teams, Meet or Lark. */
export function MiniScreen() {
  const [lines, setLines] = useState<Line[]>([]);
  const [partial, setPartial] = useState<PartialLine | null>(null);
  const [lang, setLang] = useState('en');
  useEffect(() => {
    void api.data.get().then(d => setLang(d.settings.myLang));
    void api.session.snapshot().then(s => { if (s) { setLines(s.lines); setPartial(s.partial); } });
    return api.session.onEvent(e => {
      if (e.type === 'line') setLines(ls => { const i = ls.findIndex(l => l.id === e.line.id); const next = i >= 0 ? ls.map(l => (l.id === e.line.id ? e.line : l)) : [...ls, e.line]; return next.slice(-6); });
      if (e.type === 'partial') setPartial(e.partial && e.partial.text ? e.partial : null);
      if (e.type === 'ended') setPartial(null);
    });
  }, []);
  const last = lines.slice(partial ? -1 : -2);
  return (
    <div className="mini standalone" role="region" aria-label="Bibbly Mini captions">
      <div className="mini-head drag">
        <Mascot state={partial ? 'listen' : 'translate'} size={30} /><span className="mini-title">Bibbly Mini</span><span className="chip sm" lang={langTag(lang)}>{langNative(lang)}</span>
        <button className="icon-btn sm no-drag" aria-label="Close mini captions" onClick={() => void api.mini.toggle(false)}><Icon n="x" size={16} /></button>
      </div>
      <div className="mini-body">
        {last.map((l, i) => { const g = lineText(l, lang); return <p key={l.id} className={`mini-line${i < last.length - 1 || partial ? ' dim' : ''}`}><b>{l.speaker.name}</b> <span lang={langTag(g.missing ? l.lang : lang)}>{g.text}</span></p>; })}
        {partial && <p className="mini-line"><b>{partial.speaker.name}</b> <span className="live">{partial.text}</span></p>}
        {!last.length && !partial && <p className="mini-line dim">Waiting for speech…</p>}
      </div>
    </div>
  );
}
