import { langNative, type Note } from '@bibbly/core';
import { router } from 'expo-router';
import { FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useData } from '../../src/store';
import { radius, useTheme } from '../../src/theme';
import { Icon } from '../../src/ui/Icon';
import { Empty, Title } from '../../src/ui/kit';

function NoteRow({ note }: { note: Note }) {
  const t = useTheme();
  const when = new Date(note.startedAt);
  const mins = Math.max(1, Math.round(note.durationSec / 60));
  const actions = note.clarity?.actions.length ?? 0;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${note.title}, ${when.toLocaleDateString()}`} onPress={() => router.push(`/note/${note.id}`)}
      style={({ pressed }) => ({ backgroundColor: pressed ? t.fill : t.surface, borderColor: t.line, borderWidth: 1, borderRadius: radius.l, padding: 16, gap: 6 })}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ color: t.ink, fontSize: 17, fontWeight: '700', flex: 1 }} numberOfLines={2}>{note.title}</Text>
        <Icon n="right" color={t.ink3} size={18} />
      </View>
      <Text style={{ color: t.ink2 }}>
        {when.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · {when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · {mins} min
      </Text>
      <Text style={{ color: t.ink3, fontSize: 13 }}>
        {note.languages.map(langNative).join(' · ')}{actions ? ` · ${actions} action item${actions === 1 ? '' : 's'}` : ''}{note.pendingReason ? ' · not transcribed yet' : ''}
      </Text>
    </Pressable>
  );
}

export default function NotesScreen() {
  const t = useTheme();
  const notes = useData(d => d.notes);
  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: t.bg }}>
      <FlatList
        data={notes}
        keyExtractor={n => n.id}
        renderItem={({ item }) => <NoteRow note={item} />}
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}
        ListHeaderComponent={<Title eyebrow="Notes">Meetings and memos</Title>}
        ListEmptyComponent={<Empty title="No notes yet" body="Stop a live session or import a Stick recording, and Bibbly writes the notes here." />}
      />
    </SafeAreaView>
  );
}
