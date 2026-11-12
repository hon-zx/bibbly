/**
 * Bibbly: a jelly speech-bubble sprite with a curled tail, arm nubs and a floating
 * "spark" that shows what Bibbly is doing. Original character (no fur, wings or antennae).
 */
export type MascotState = 'idle' | 'wave' | 'listen' | 'translate' | 'think' | 'happy' | 'sleep';

const BODY = 'M100 34C142 34 170 60 170 98C170 136 144 160 104 162C92 163 80 162 70 159C62 168 47 174 33 172C41 165 46 156 46 148C36 138 30 120 30 100C30 60 58 34 100 34Z';
const LABEL: Record<MascotState, string> = {
  idle: 'Bibbly', wave: 'Bibbly waving', listen: 'Bibbly listening', translate: 'Bibbly translating', think: 'Bibbly thinking', happy: 'Bibbly celebrating', sleep: 'Bibbly resting',
};
const LINE = 'var(--bb-line)';

export function Mascot({ state = 'idle', size = 96 }: { state?: MascotState; size?: number }) {
  const eyes = state === 'happy'
    ? <path d="M71 95q11-12 22 0M107 95q11-12 22 0" fill="none" stroke={LINE} strokeWidth={5.5} strokeLinecap="round" />
    : state === 'sleep'
      ? <path d="M71 92q11 8 22 0M107 92q11 8 22 0" fill="none" stroke={LINE} strokeWidth={5} strokeLinecap="round" />
      : (
        <g className={`bb-eyes${state === 'translate' ? ' glance' : ''}${state === 'think' ? ' up' : ''}`}>
          <ellipse cx="82" cy="92" rx="9.5" ry="12.5" fill={LINE} /><ellipse cx="118" cy="92" rx="9.5" ry="12.5" fill={LINE} />
          <circle cx="85.5" cy="86.5" r="3.6" fill="#fff" /><circle cx="121.5" cy="86.5" r="3.6" fill="#fff" />
          <circle cx="79" cy="97" r="1.8" fill="#fff" /><circle cx="115" cy="97" r="1.8" fill="#fff" />
        </g>
      );
  const mouth = state === 'happy' || state === 'wave'
    ? <><path d="M88 111q12 15 24 0z" fill={LINE} stroke={LINE} strokeWidth={3} strokeLinejoin="round" /><path d="M95 116q5 4 10 0" fill="var(--bb-cheek)" /></>
    : state === 'listen' ? <ellipse cx="100" cy="115" rx="4.5" ry="5.5" fill={LINE} />
    : state === 'think' ? <path d="M92 115q4-3 8 0t8 0" fill="none" stroke={LINE} strokeWidth={3.5} strokeLinecap="round" />
    : state === 'sleep' ? <path d="M95 114q5 3 10 0" fill="none" stroke={LINE} strokeWidth={3.5} strokeLinecap="round" />
    : <path d="M90 111q10 10 20 0" fill="none" stroke={LINE} strokeWidth={4} strokeLinecap="round" />;
  const star = 'M100 1l4 10.5L114.5 16 104 20 100 30.5 96 20 85.5 16 96 11.5z';
  const spark = state === 'listen'
    ? <g className="bb-spark eq"><rect x="88" y="10" width="6" height="16" rx="3" /><rect x="97" y="5" width="6" height="26" rx="3" /><rect x="106" y="10" width="6" height="16" rx="3" /></g>
    : state === 'think'
      ? <g className="bb-spark think"><circle cx="100" cy="16" r="14" fill="var(--sun)" stroke={LINE} strokeWidth={3} /><circle cx="93" cy="16" r="2.4" fill={LINE} /><circle cx="100" cy="16" r="2.4" fill={LINE} /><circle cx="107" cy="16" r="2.4" fill={LINE} /></g>
      : state === 'sleep'
        ? <g className="bb-spark zz"><text x="108" y="24" fontFamily="Fredoka, ui-rounded, sans-serif" fontWeight={600} fontSize={22} fill={LINE}>z</text><text x="124" y="12" fontFamily="Fredoka, ui-rounded, sans-serif" fontWeight={600} fontSize={14} fill={LINE}>z</text></g>
        : <g className={`bb-spark${state === 'translate' ? ' spin' : state === 'happy' ? ' burst' : ''}`}><path d={star} fill="var(--sun)" stroke={LINE} strokeWidth={2.5} strokeLinejoin="round" /></g>;
  return (
    <svg className={`bb bb--${state}`} width={size} height={size} viewBox="0 0 200 200" role="img" aria-label={LABEL[state]}>
      <ellipse className="bb-shadow" cx="100" cy="190" rx="44" ry="6.5" />
      <g className="bb-float">
        {spark}
        {state === 'listen' && (
          <g className="bb-waves" fill="none" stroke="var(--lagoon)" strokeWidth={4.5} strokeLinecap="round">
            <path className="w1" d="M22 86q-8 14 0 28" /><path className="w2" d="M10 78q-13 22 0 44" />
            <path className="w1" d="M178 86q8 14 0 28" /><path className="w2" d="M190 78q13 22 0 44" />
          </g>
        )}
        <g className="bb-arm-l"><ellipse cx="37" cy="118" rx="12" ry="9" transform="rotate(-28 37 118)" fill="var(--bb-body)" stroke={LINE} strokeWidth={5} /></g>
        <g className={`bb-arm-r${state === 'wave' || state === 'happy' ? ' up' : ''}`}><ellipse cx="163" cy="118" rx="12" ry="9" transform="rotate(28 163 118)" fill="var(--bb-body)" stroke={LINE} strokeWidth={5} /></g>
        <path d={BODY} fill="var(--bb-body)" stroke={LINE} strokeWidth={5} strokeLinejoin="round" />
        <ellipse cx="103" cy="137" rx="38" ry="18" fill="var(--bb-belly)" />
        <ellipse cx="70" cy="58" rx="15" ry="7" transform="rotate(-24 70 58)" fill="#fff" opacity={0.55} />
        <ellipse cx="64" cy="109" rx="9" ry="5.5" fill="var(--bb-cheek)" opacity={0.7} /><ellipse cx="136" cy="109" rx="9" ry="5.5" fill="var(--bb-cheek)" opacity={0.7} />
        {eyes}{mouth}
        {state === 'translate' && (
          <g className="bb-badge"><rect x="80" y="127" width="46" height="21" rx="10.5" fill={LINE} />
            <text x="103" y="142" textAnchor="middle" fontFamily="Figtree, system-ui, sans-serif" fontWeight={700} fontSize={12.5} fill="var(--bb-belly)">A⇄文</text></g>
        )}
      </g>
    </svg>
  );
}

/** The Bibbly Stick, with Bibbly's eyes as its status lights. */
export function StickArt({ connected, recording }: { connected: boolean; recording?: boolean }) {
  const on = connected || !!recording;
  return (
    <svg className={`stick-svg${connected ? ' is-on' : ''}`} viewBox="0 0 340 150" role="img" aria-label={`Bibbly Stick, ${connected ? 'connected' : 'not connected'}`}>
      <ellipse cx="180" cy="134" rx="130" ry="7" fill="var(--ink)" opacity={0.08} />
      <rect x="10" y="61" width="44" height="28" rx="7" fill="var(--metal)" stroke={LINE} strokeWidth={3.5} />
      <rect x="20" y="70" width="24" height="10" rx="4" fill={LINE} opacity={0.55} />
      <rect x="50" y="28" width="264" height="94" rx="47" fill="var(--bb-body)" stroke={LINE} strokeWidth={4.5} />
      <path d="M86 40h196" stroke="#fff" strokeWidth={7} strokeLinecap="round" opacity={0.5} />
      <circle cx="104" cy="75" r="19" fill="var(--bb-belly)" stroke={LINE} strokeWidth={3.5} />
      <circle cx="104" cy="75" r="8" fill={recording ? 'var(--coral-fill)' : LINE} />
      <g className="stick-eyes">
        {on && <ellipse className="stick-glow" cx="186" cy="70" rx="30" ry="18" fill={recording && !connected ? 'var(--coral-fill)' : 'var(--lagoon)'} opacity={0.16} />}
        <ellipse className="stick-eye" cx="170" cy="70" rx="8" ry="10.5" fill={on ? '#fff' : LINE} stroke={on ? LINE : 'none'} strokeWidth={2.5} />
        <ellipse className="stick-eye" cx="202" cy="70" rx="8" ry="10.5" fill={on ? '#fff' : LINE} stroke={on ? LINE : 'none'} strokeWidth={2.5} />
      </g>
      <path d="M178 90q8 7 16 0" fill="none" stroke={LINE} strokeWidth={3.5} strokeLinecap="round" />
      <g fill={LINE} opacity={0.7}>
        {[0, 1, 2].flatMap(r => [0, 1, 2, 3].map(c => <circle key={`${r}-${c}`} cx={246 + c * 11 + (r % 2) * 5} cy={60 + r * 12} r={2.6} />))}
      </g>
      <circle cx="300" cy="75" r="7" fill="none" stroke={LINE} strokeWidth={3.5} />
    </svg>
  );
}
