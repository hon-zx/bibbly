import { describeClaudeError } from '@bibbly/core/claude';
import { fmtClock, itemText, langNative, type LangCode, type Note } from '@bibbly/core';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { actionInTasks, addActionToTasks, deleteNote, needsTranslation, translateNote } from '../../src/notes';
import { SHARE_FORMATS, shareNote } from '../../src/share';
import { useData } from '../../src/store';
import { useTheme } from '../../src/theme';
import { CaptionRow, ClarityView, useSpeakerColors } from '../../src/ui/captions';
import { Icon } from '../../src/ui/Icon';
import { Banner, Body, Button, Card, Chip, Empty, H2, Row } from '../../src/ui/kit';

export default function NoteScreen() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const notes = useData(d => d.notes);
  const tasks = useData(d => d.tasks);
  const myLang = useData(d => d.settings.myLang);
  const note = notes.find(n => n.id === id) as Note | undefined;
  const [lang, setLang] = useState<LangCode>(myLang);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const langs = useMemo(() => (note ? [...new Set([myLang, ...note.languages])] : [myLang]), [note, myLang]);
  const colorOf = useSpeakerColors(note?.lines ?? []);

  if (!note) return <Empty title="This note is gone" body="It may have been deleted on this phone." />;

  const translate = async () => {
    setBusy('translate');
    try { await translateNote(note, lang); } catch (err) { setMessage(describeClaudeError(err)); } finally { setBusy(null); }
  };
  const share = async (format: (typeof SHARE_FORMATS)[number]['id']) => {
    setBusy(format);
    try {
      const ready = needsTranslation(note, lang) ? await translateNote(note, lang).catch(() => note) : note;
      await shareNote(ready, format, lang);
    } catch (err) { setMessage(err instanceof Error ? err.message : 'Could not share the note.'); } finally { setBusy(null); }
  };
  const remove = () => Alert.alert('Delete this note?', 'The transcript and notes are removed from this phone.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => { deleteNote(note.id); router.back(); } },
  ]);

  const when = new Date(note.startedAt);
  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 48 }}>
      <View style={{ gap: 4 }}>
        <Text accessibilityRole="header" style={{ color: t.ink, fontSize: 24, fontWeight: '700' }}>{note.title}</Text>
        <Text style={{ color: t.ink2 }}>
          {when.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {fmtClock(note.durationSec)} · {note.source}
        </Text>
      </View>
      {message ? <Banner tone="coral" onClose={() => setMessage(null)}>{message}</Banner> : null}
      {note.pendingReason ? <Banner tone="sun">{note.pendingReason}</Banner> : null}

      <View style={{ gap: 8 }}>
        <Text style={{ color: t.ink, fontWeight: '600' }}>Read in</Text>
        <Row wrap>{langs.map(l => <Chip key={l} label={langNative(l)} selected={l === lang} onPress={() => setLang(l)} />)}</Row>
        {needsTranslation(note, lang) ? (
          <Button kind="soft" icon="globe" label={`Translate into ${langNative(lang)}`} busy={busy === 'translate'} onPress={() => void translate()} />
        ) : null}
      </View>

      {note.clarity ? <ClarityView clarity={note.clarity} lang={lang} /> : null}
      {note.clarity?.actions.length ? (
        <Card>
          <H2>Make them to-dos</H2>
          {note.clarity.actions.map(a => {
            const added = actionInTasks(note, a) || tasks.some(x => x.source?.actionId === a.id && x.source.noteId === note.id);
            return (
              <Pressable key={a.id} accessibilityRole="button" accessibilityState={{ disabled: added }} disabled={added}
                onPress={() => addActionToTasks(note, a, lang)} style={styles.action}>
                <Icon n={added ? 'tick' : 'plus'} color={added ? t.lagoon : t.ink2} size={18} />
                <Text style={{ color: added ? t.ink3 : t.ink, flex: 1 }}>{itemText(a, lang).text}</Text>
                <Text style={{ color: t.ink3, fontSize: 13 }}>{added ? 'Added' : 'Add'}</Text>
              </Pressable>
            );
          })}
        </Card>
      ) : null}

      <Card>
        <H2>Share</H2>
        <Body muted small>Opens the share sheet, so you can send it to Teams, Slack, Notion, Lark, Google Drive or email.</Body>
        {SHARE_FORMATS.map(f => (
          <Pressable key={f.id} accessibilityRole="button" accessibilityLabel={`Share as ${f.label}`} onPress={() => void share(f.id)} style={styles.action} disabled={!!busy}>
            <Icon n="share" color={t.lagoon} size={18} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.ink, fontWeight: '600' }}>{f.label}</Text>
              <Text style={{ color: t.ink3, fontSize: 13 }}>{f.detail}</Text>
            </View>
            {busy === f.id ? <Text style={{ color: t.ink3 }}>…</Text> : null}
          </Pressable>
        ))}
      </Card>

      <View style={{ gap: 4 }}>
        <H2>Transcript</H2>
        {note.lines.length
          ? note.lines.map(l => <View key={l.id} style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line }}><CaptionRow line={l} lang={lang} color={colorOf(l.speaker.id, l.speaker.self)} /></View>)
          : <Body muted>No transcript.</Body>}
      </View>
      <Button kind="ghost" icon="trash" label="Delete note" onPress={remove} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  action: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingVertical: 6 },
});
