import { LANGUAGES, fmtClock, langNative } from '@bibbly/core';
import { useKeepAwake } from 'expo-keep-awake';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { FlatList, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  discardLive, dismissNotice, getLive, joinRoom, refreshNotes, setCaptionLang, startLive, stopLive, subscribeLive, type LiveState,
} from '../../src/live';
import { useData } from '../../src/store';
import { useTheme } from '../../src/theme';
import { CaptionRow, ClarityView, PartialRow, useSpeakerColors } from '../../src/ui/captions';
import { Banner, Body, Button, Card, Chip, Field, H2, IconButton, Row, Title } from '../../src/ui/kit';
import { Mascot } from '../../src/ui/Mascot';

function useLive(): LiveState {
  return useSyncExternalStore(subscribeLive, getLive, getLive);
}

/** "Captions in" switcher: your language first, then the languages people speak, then the rest. */
function LangChips({ value, onChange }: { value: string; onChange: (l: string) => void }) {
  const settings = useData(d => d.settings);
  const order = useMemo(() => {
    const first = [...new Set([settings.myLang, ...settings.speaking])];
    return [...first, ...LANGUAGES.map(l => l.code).filter(c => !first.includes(c))];
  }, [settings.myLang, settings.speaking]);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
      accessibilityLabel="Captions in">
      {order.map(c => <Chip key={c} label={langNative(c)} selected={value === c} onPress={() => onChange(c)} accessibilityLabel={`Captions in ${langNative(c)}`} />)}
    </ScrollView>
  );
}

function KeepAwake() {
  useKeepAwake();
  return null;
}

export default function LiveScreen() {
  const t = useTheme();
  const live = useLive();
  const [code, setCode] = useState('');
  const [now, setNow] = useState(Date.now());
  const list = useRef<FlatList>(null);
  const colorOf = useSpeakerColors(live.lines);
  const active = live.status !== 'idle';

  useEffect(() => {
    if (!active) return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [active]);

  const notice = live.notice ? <Banner tone="sun" onClose={dismissNotice}>{live.notice}</Banner> : null;

  if (!active) {
    return (
      <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: t.bg }}>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <Title eyebrow="Bibbly">Live captions</Title>
          {notice}
          {live.lastNoteId ? (
            <Card tone="lagoon">
              <Row><Mascot state="happy" size={56} /><View style={{ flex: 1 }}><H2>That’s a wrap</H2><Body muted>Saved to Notes, with Clarity notes.</Body></View></Row>
              <Button kind="primary" label="Open the note" icon="notes" onPress={() => router.push(`/note/${live.lastNoteId}`)} />
            </Card>
          ) : null}
          <Card style={{ alignItems: 'center', paddingVertical: 24 }}>
            <Mascot state="wave" size={132} />
            <H2>Everyone in their own language</H2>
            <Body muted style={{ textAlign: 'center' }}>Bibbly listens, works out who speaks which language, and shows you every line in yours.</Body>
          </Card>
          <View style={{ gap: 8 }}>
            <Text style={{ color: t.ink, fontWeight: '600' }}>Captions in</Text>
            <View style={{ marginHorizontal: -16 }}><LangChips value={live.captionLang} onChange={setCaptionLang} /></View>
          </View>
          <Button kind="primary" icon="mic" label="Start listening" onPress={() => void startLive('mic')} />
          <Button kind="soft" icon="play" label="Play the demo meeting" onPress={() => void startLive('demo')} />
          <Card>
            <H2>Join a meeting</H2>
            <Body muted small>Someone is captioning on Bibbly for desktop? Enter their room code to read along in your language.</Body>
            <Field label="Room code" value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false} placeholder="e.g. k7m2qp"
              returnKeyType="go" onSubmitEditing={() => code && joinRoom(code)} />
            <Button label="Join" icon="users" disabled={!code.trim()} onPress={() => joinRoom(code)} />
          </Card>
        </ScrollView>
      </SafeAreaView>
    );
  }

  const elapsed = live.startedAt ? (now - live.startedAt) / 1000 : 0;
  const mascot = live.status === 'starting' ? 'think' : live.partial ? 'listen' : live.lines.length ? 'translate' : 'listen';
  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: t.bg }}>
      {Platform.OS !== 'web' ? <KeepAwake /> : null}
      <View style={styles.head}>
        <Mascot state={mascot} size={52} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ color: t.ink, fontSize: 18, fontWeight: '700' }}>{live.title}</Text>
          <Text style={{ color: live.status === 'live' ? t.lagoon : t.ink3, fontWeight: '600' }} accessibilityLiveRegion="polite">
            {live.status === 'starting' ? 'Starting…' : live.status === 'stopping' ? 'Saving…' : live.mode === 'room'
              ? `${live.room?.connected ? 'In room' : 'Reconnecting'} ${live.room?.code ?? ''} · ${live.room?.members.length ?? 0} people`
              : `Listening · ${fmtClock(elapsed)}`}
          </Text>
        </View>
      </View>
      <View style={{ paddingBottom: 8 }}><LangChips value={live.captionLang} onChange={setCaptionLang} /></View>
      {notice ? <View style={{ paddingHorizontal: 16 }}>{notice}</View> : null}
      <FlatList
        ref={list}
        data={live.lines}
        keyExtractor={l => l.id}
        renderItem={({ item }) => <CaptionRow line={item} lang={live.captionLang} color={colorOf(item.speaker.id, item.speaker.self)} />}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16 }}
        ItemSeparatorComponent={() => <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.line }} />}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={<Body muted style={{ paddingVertical: 24, textAlign: 'center' }}>Captions appear here as people talk.</Body>}
        ListFooterComponent={
          <View style={{ gap: 12 }}>
            {live.partial ? <PartialRow partial={live.partial} /> : null}
            {live.clarity && live.mode !== 'room' ? <ClarityView clarity={live.clarity} lang={live.captionLang} /> : null}
          </View>
        }
      />
      <View style={[styles.bar, { backgroundColor: t.surface, borderTopColor: t.line }]}>
        <IconButton icon="x" label="Discard without saving" onPress={() => void discardLive()} />
        {live.mode !== 'room' ? <IconButton icon="sparkle" label="Refresh the notes" onPress={() => void refreshNotes()} color={t.lagoon} /> : null}
        <View style={{ flex: 1 }}>
          <Button kind="danger" label={live.mode === 'room' ? 'Leave & save' : 'Stop & save'} icon="stop" busy={live.status === 'stopping'} onPress={() => void stopLive()} />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 8 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderTopWidth: StyleSheet.hairlineWidth },
});
