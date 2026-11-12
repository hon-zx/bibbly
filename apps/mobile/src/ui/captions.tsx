import {
  clarityLabel, detectedLabel, fmtClock, itemText, langTag, lineText, type Clarity, type LangCode, type Line, type PartialLine,
} from '@bibbly/core';
import { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SPEAKER_COLORS, useTheme } from '../theme';
import { useColorScheme } from 'react-native';
import { Card, H2 } from './kit';

/** Colours speakers in the order they first speak, so people in one conversation never share a colour. */
export function useSpeakerColors(lines: Line[]): (id: string, self?: boolean) => string {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return useMemo(() => {
    const palette = SPEAKER_COLORS[scheme];
    const order = new Map<string, number>();
    for (const l of lines) if (!l.speaker.self && !order.has(l.speaker.id)) order.set(l.speaker.id, order.size);
    return (id: string, self?: boolean) => (self ? palette[0]! : palette[1 + ((order.get(id) ?? 0) % (palette.length - 1))]!);
  }, [lines, scheme]);
}

/** One caption: what the reader sees in their language, with the original underneath when translated. */
export const CaptionRow = memo(function CaptionRow({ line, lang, color }: { line: Line; lang: LangCode; color: string }) {
  const t = useTheme();
  const shown = lineText(line, lang);
  return (
    <View style={styles.row} accessible accessibilityLabel={`${line.speaker.name}, ${detectedLabel(line.lang, line.langs)}: ${shown.text}`}>
      <View style={styles.meta}>
        <Text style={[styles.speaker, { color }]}>{line.speaker.self ? 'You' : line.speaker.name}</Text>
        <Text style={[styles.detail, { color: t.ink3 }]}>{fmtClock(line.t)} · {detectedLabel(line.lang, line.langs)}</Text>
      </View>
      <Text lang={langTag(shown.missing ? line.lang : lang)} style={[styles.main, { color: shown.missing ? t.ink2 : t.ink }]}>{shown.text}</Text>
      {!shown.same && !shown.missing ? <Text lang={langTag(line.lang)} style={[styles.original, { color: t.ink3 }]}>{line.text}</Text> : null}
      {shown.missing ? <Text style={[styles.original, { color: t.ink3 }]}>Translating…</Text> : null}
    </View>
  );
});

export function PartialRow({ partial }: { partial: PartialLine }) {
  const t = useTheme();
  if (!partial.text) {
    return <Text style={[styles.detail, { color: t.ink3, paddingVertical: 8 }]}>{partial.speaker.name} is speaking…</Text>;
  }
  return (
    <View style={[styles.row, { opacity: 0.7 }]}>
      <Text style={[styles.speaker, { color: t.ink2 }]}>{partial.speaker.self ? 'You' : partial.speaker.name}</Text>
      <Text style={[styles.main, { color: t.ink2, fontStyle: 'italic' }]}>{partial.text}</Text>
    </View>
  );
}

/** Summary, decisions, action items and follow-up, in the reader's language. */
export function ClarityView({ clarity, lang }: { clarity: Clarity; lang: LangCode }) {
  const t = useTheme();
  if (!clarity.summary.length && !clarity.decisions.length && !clarity.actions.length && !clarity.followup) return null;
  const section = (key: 'summary' | 'decisions', items: Clarity['summary']) =>
    items.length ? (
      <View style={{ gap: 6 }}>
        <Text style={[styles.label, { color: t.lagoon }]}>{clarityLabel(lang, key)}</Text>
        {items.map((it, i) => <Text key={i} style={[styles.bullet, { color: t.ink }]}>• {itemText(it, lang).text}</Text>)}
      </View>
    ) : null;
  return (
    <Card>
      <H2>Clarity</H2>
      {section('summary', clarity.summary)}
      {section('decisions', clarity.decisions)}
      {clarity.actions.length ? (
        <View style={{ gap: 6 }}>
          <Text style={[styles.label, { color: t.lagoon }]}>{clarityLabel(lang, 'actions')}</Text>
          {clarity.actions.map(a => (
            <Text key={a.id} style={[styles.bullet, { color: t.ink }]}>
              ☐ {itemText(a, lang).text}
              <Text style={{ color: t.ink3 }}> · {a.ownerIsMe ? 'You' : a.owner}{a.due ? `, ${new Date(a.due).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}` : ''}</Text>
            </Text>
          ))}
        </View>
      ) : null}
      {clarity.followup ? (
        <View style={{ gap: 6 }}>
          <Text style={[styles.label, { color: t.lagoon }]}>{clarityLabel(lang, 'followup')}</Text>
          <Text style={[styles.bullet, { color: t.ink }]}>{itemText(clarity.followup, lang).text}</Text>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 10, gap: 3 },
  meta: { flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
  speaker: { fontWeight: '700', fontSize: 14 },
  detail: { fontSize: 12.5 },
  main: { fontSize: 19, lineHeight: 26, fontWeight: '500' },
  original: { fontSize: 14, lineHeight: 19 },
  label: { fontSize: 12.5, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  bullet: { fontSize: 15, lineHeight: 21 },
});
