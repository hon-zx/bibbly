import { addDays, parseQuickTask, startOfDay, uid, type Task } from '@bibbly/core';
import { useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { update, useData } from '../../src/store';
import { radius, useTheme } from '../../src/theme';
import { Icon } from '../../src/ui/Icon';
import { Chip, Empty, IconButton, Row, Title } from '../../src/ui/kit';

type Filter = 'today' | 'upcoming' | 'all' | 'done';

function dueLabel(due: number | null): string {
  if (due == null) return '';
  const d = new Date(due);
  const today = startOfDay(Date.now()).getTime();
  const day = startOfDay(d).getTime();
  const time = d.getHours() + d.getMinutes() > 0 ? ` ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
  if (day === today) return `Today${time}`;
  if (day === addDays(today, 1).getTime()) return `Tomorrow${time}`;
  if (day < today) return `Overdue · ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}${time}`;
}

function TaskRow({ task }: { task: Task }) {
  const t = useTheme();
  const overdue = !task.done && task.due != null && task.due < startOfDay(Date.now()).getTime();
  const toggle = () => update(d => ({ tasks: d.tasks.map(x => (x.id === task.id ? { ...x, done: !x.done, doneAt: x.done ? null : Date.now() } : x)) }));
  const remind = () => update(d => ({ tasks: d.tasks.map(x => (x.id === task.id ? { ...x, remind: !x.remind } : x)) }));
  const remove = () => Alert.alert('Delete this task?', task.title, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => update(d => ({ tasks: d.tasks.filter(x => x.id !== task.id) })) },
  ]);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: t.surface, borderColor: t.line, borderWidth: 1, borderRadius: radius.m, paddingLeft: 12, paddingVertical: 4 }}>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: task.done }} accessibilityLabel={task.title} onPress={toggle} hitSlop={8}
        style={{ width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: task.done ? t.lagoon : t.ink3, backgroundColor: task.done ? t.lagoon : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
        {task.done ? <Icon n="tick" color={t.onLagoon} size={16} /> : null}
      </Pressable>
      <Pressable style={{ flex: 1, paddingVertical: 8 }} onLongPress={remove} accessibilityHint="Long press to delete">
        <Text style={{ color: task.done ? t.ink3 : t.ink, fontSize: 16, textDecorationLine: task.done ? 'line-through' : 'none' }}>{task.title}</Text>
        <Text style={{ color: overdue ? t.coral : t.ink3, fontSize: 13 }}>
          {[dueLabel(task.due), task.list, task.source ? 'from a meeting' : ''].filter(Boolean).join(' · ')}
        </Text>
      </Pressable>
      <IconButton icon="bell" label={task.remind ? 'Turn reminder off' : 'Remind me'} onPress={remind} color={task.remind ? t.lagoon : t.ink3} />
    </View>
  );
}

export default function TasksScreen() {
  const t = useTheme();
  const tasks = useData(d => d.tasks);
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<Filter>('today');

  const shown = useMemo(() => {
    const end = addDays(startOfDay(Date.now()), 1).getTime();
    const open = tasks.filter(x => !x.done);
    const list =
      filter === 'done' ? tasks.filter(x => x.done)
      : filter === 'today' ? open.filter(x => x.due != null && x.due < end)
      : filter === 'upcoming' ? open.filter(x => x.due != null && x.due >= end)
      : open;
    return [...list].sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity));
  }, [tasks, filter]);

  const add = () => {
    const v = text.trim();
    if (!v) return;
    const p = parseQuickTask(v, new Date());
    const task: Task = { id: uid('task-'), title: p.title, list: p.list, due: p.due, remind: p.remind, done: false };
    update(d => ({ tasks: [task, ...d.tasks] }));
    setText('');
    if (filter === 'done') setFilter('all');
  };

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: t.bg }}>
      <FlatList
        data={shown}
        keyExtractor={x => x.id}
        renderItem={({ item }) => <TaskRow task={item} />}
        contentContainerStyle={{ padding: 16, gap: 8, paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={{ gap: 14, marginBottom: 6 }}>
            <Title eyebrow="Tasks">To-dos and reminders</Title>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: t.surface, borderColor: t.line, borderWidth: 1, borderRadius: radius.m, paddingLeft: 14 }}>
              <TextInput value={text} onChangeText={setText} onSubmitEditing={add} returnKeyType="done" placeholderTextColor={t.ink3}
                placeholder="Call Mom tonight 8pm · Send deck Friday #work" accessibilityLabel="Add a task"
                style={{ flex: 1, minHeight: 48, color: t.ink, fontSize: 16 }} />
              <IconButton icon="plus" label="Add task" onPress={add} color={t.lagoon} />
            </View>
            <Row wrap>
              {(['today', 'upcoming', 'all', 'done'] as const).map(f => (
                <Chip key={f} label={f[0]!.toUpperCase() + f.slice(1)} selected={filter === f} onPress={() => setFilter(f)} />
              ))}
            </Row>
          </View>
        }
        ListEmptyComponent={<Empty mascot="happy" title={filter === 'done' ? 'Nothing done yet' : 'All clear'} body="Type a task above, or add action items from a meeting note." />}
      />
    </SafeAreaView>
  );
}
