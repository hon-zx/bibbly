import Svg, { Circle, Ellipse, G, Path, Rect, Text as SvgText } from 'react-native-svg';
import { useTheme } from '../theme';

/**
 * Bibbly: a jelly speech-bubble with a curled tail, arm nubs and a floating
 * "spark" showing what it's doing. The same original character as on desktop.
 */
export type MascotState = 'idle' | 'wave' | 'listen' | 'translate' | 'think' | 'happy' | 'sleep';

const BODY = 'M100 34C142 34 170 60 170 98C170 136 144 160 104 162C92 163 80 162 70 159C62 168 47 174 33 172C41 165 46 156 46 148C36 138 30 120 30 100C30 60 58 34 100 34Z';
const STAR = 'M100 1l4 10.5L114.5 16 104 20 100 30.5 96 20 85.5 16 96 11.5z';
const LABEL: Record<MascotState, string> = {
  idle: 'Bibbly', wave: 'Bibbly waving', listen: 'Bibbly listening', translate: 'Bibbly translating', think: 'Bibbly thinking',
  happy: 'Bibbly celebrating', sleep: 'Bibbly resting',
};

export function Mascot({ state = 'idle', size = 96 }: { state?: MascotState; size?: number }) {
  const t = useTheme();
  const L = t.bbLine;
  const eyes =
    state === 'happy' ? <Path d="M71 95q11-12 22 0M107 95q11-12 22 0" fill="none" stroke={L} strokeWidth={5.5} strokeLinecap="round" />
    : state === 'sleep' ? <Path d="M71 92q11 8 22 0M107 92q11 8 22 0" fill="none" stroke={L} strokeWidth={5} strokeLinecap="round" />
    : (
      <G transform={state === 'translate' ? 'translate(4 0)' : state === 'think' ? 'translate(0 -4)' : undefined}>
        <Ellipse cx={82} cy={92} rx={9.5} ry={12.5} fill={L} /><Ellipse cx={118} cy={92} rx={9.5} ry={12.5} fill={L} />
        <Circle cx={85.5} cy={86.5} r={3.6} fill="#fff" /><Circle cx={121.5} cy={86.5} r={3.6} fill="#fff" />
        <Circle cx={79} cy={97} r={1.8} fill="#fff" /><Circle cx={115} cy={97} r={1.8} fill="#fff" />
      </G>
    );
  const mouth =
    state === 'happy' || state === 'wave' ? <><Path d="M88 111q12 15 24 0z" fill={L} stroke={L} strokeWidth={3} strokeLinejoin="round" /><Path d="M95 116q5 4 10 0" fill={t.bbCheek} /></>
    : state === 'listen' ? <Ellipse cx={100} cy={115} rx={4.5} ry={5.5} fill={L} />
    : state === 'think' ? <Path d="M92 115q4-3 8 0t8 0" fill="none" stroke={L} strokeWidth={3.5} strokeLinecap="round" />
    : state === 'sleep' ? <Path d="M95 114q5 3 10 0" fill="none" stroke={L} strokeWidth={3.5} strokeLinecap="round" />
    : <Path d="M90 111q10 10 20 0" fill="none" stroke={L} strokeWidth={4} strokeLinecap="round" />;
  const spark =
    state === 'listen' ? <G fill={L}><Rect x={88} y={10} width={6} height={16} rx={3} /><Rect x={97} y={5} width={6} height={26} rx={3} /><Rect x={106} y={10} width={6} height={16} rx={3} /></G>
    : state === 'think' ? <G><Circle cx={100} cy={16} r={14} fill={t.sun} stroke={L} strokeWidth={3} /><Circle cx={93} cy={16} r={2.4} fill={L} /><Circle cx={100} cy={16} r={2.4} fill={L} /><Circle cx={107} cy={16} r={2.4} fill={L} /></G>
    : state === 'sleep' ? <G><SvgText x={108} y={24} fontWeight="600" fontSize={22} fill={L}>z</SvgText><SvgText x={124} y={12} fontWeight="600" fontSize={14} fill={L}>z</SvgText></G>
    : <Path d={STAR} fill={t.sun} stroke={L} strokeWidth={2.5} strokeLinejoin="round" />;
  const armUp = state === 'wave' || state === 'happy';
  return (
    <Svg width={size} height={size} viewBox="0 0 200 200" accessibilityRole="image" accessibilityLabel={LABEL[state]}>
      <Ellipse cx={100} cy={190} rx={44} ry={6.5} fill={t.ink} opacity={0.08} />
      {spark}
      {state === 'listen' && (
        <G fill="none" stroke={t.lagoon} strokeWidth={4.5} strokeLinecap="round">
          <Path d="M22 86q-8 14 0 28" /><Path d="M10 78q-13 22 0 44" /><Path d="M178 86q8 14 0 28" /><Path d="M190 78q13 22 0 44" />
        </G>
      )}
      <Ellipse cx={37} cy={118} rx={12} ry={9} transform="rotate(-28 37 118)" fill={t.bbBody} stroke={L} strokeWidth={5} />
      <Ellipse cx={163} cy={armUp ? 96 : 118} rx={12} ry={9} transform={`rotate(${armUp ? -40 : 28} 163 ${armUp ? 96 : 118})`} fill={t.bbBody} stroke={L} strokeWidth={5} />
      <Path d={BODY} fill={t.bbBody} stroke={L} strokeWidth={5} strokeLinejoin="round" />
      <Ellipse cx={103} cy={137} rx={38} ry={18} fill={t.bbBelly} />
      <Ellipse cx={70} cy={58} rx={15} ry={7} transform="rotate(-24 70 58)" fill="#fff" opacity={0.55} />
      <Ellipse cx={64} cy={109} rx={9} ry={5.5} fill={t.bbCheek} opacity={0.7} /><Ellipse cx={136} cy={109} rx={9} ry={5.5} fill={t.bbCheek} opacity={0.7} />
      {eyes}
      {mouth}
      {state === 'translate' && (
        <G><Rect x={80} y={127} width={46} height={21} rx={10.5} fill={L} />
          <SvgText x={103} y={142} textAnchor="middle" fontWeight="700" fontSize={12.5} fill={t.bbBelly}>A⇄文</SvgText></G>
      )}
    </Svg>
  );
}

/** The Bibbly Stick, with Bibbly's eyes as its status lights. */
export function StickArt({ connected, recording, width = 260 }: { connected: boolean; recording?: boolean; width?: number }) {
  const t = useTheme();
  const L = t.bbLine;
  const on = connected || !!recording;
  return (
    <Svg width={width} height={(width * 150) / 340} viewBox="0 0 340 150" accessibilityRole="image" accessibilityLabel={`Bibbly Stick, ${connected ? 'connected' : 'not connected'}`}>
      <Ellipse cx={180} cy={134} rx={130} ry={7} fill={t.ink} opacity={0.08} />
      <Rect x={10} y={61} width={44} height={28} rx={7} fill={t.metal} stroke={L} strokeWidth={3.5} />
      <Rect x={20} y={70} width={24} height={10} rx={4} fill={L} opacity={0.55} />
      <Rect x={50} y={28} width={264} height={94} rx={47} fill={t.bbBody} stroke={L} strokeWidth={4.5} />
      <Path d="M86 40h196" stroke="#fff" strokeWidth={7} strokeLinecap="round" opacity={0.5} />
      <Circle cx={104} cy={75} r={19} fill={t.bbBelly} stroke={L} strokeWidth={3.5} />
      <Circle cx={104} cy={75} r={8} fill={recording ? t.coralFill : L} />
      {on && <Ellipse cx={186} cy={70} rx={30} ry={18} fill={recording && !connected ? t.coralFill : t.lagoon} opacity={0.16} />}
      <Ellipse cx={170} cy={70} rx={8} ry={10.5} fill={on ? '#fff' : L} stroke={on ? L : 'none'} strokeWidth={2.5} />
      <Ellipse cx={202} cy={70} rx={8} ry={10.5} fill={on ? '#fff' : L} stroke={on ? L : 'none'} strokeWidth={2.5} />
      <Path d="M178 90q8 7 16 0" fill="none" stroke={L} strokeWidth={3.5} strokeLinecap="round" />
      <G fill={L} opacity={0.7}>
        {[0, 1, 2].flatMap(r => [0, 1, 2, 3].map(c => <Circle key={`${r}-${c}`} cx={246 + c * 11 + (r % 2) * 5} cy={60 + r * 12} r={2.6} />))}
      </G>
      <Circle cx={300} cy={75} r={7} fill="none" stroke={L} strokeWidth={3.5} />
    </Svg>
  );
}
