/** Task reminders as local notifications (no server: they fire even offline). */
import { atTime, hasTime, type Task } from '@bibbly/core';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

const PREFIX = 'task:';
const MAX = 60; // iOS keeps at most 64 pending notifications per app

/** When a reminder fires: at the due time, or 9:00 for tasks due on a day without a time. */
export const reminderAt = (due: number): number => (hasTime(due) ? due : atTime(new Date(due), '09:00').getTime());

/** Reschedules every task reminder to match the task list. */
export async function syncReminders(tasks: Task[]): Promise<void> {
  const now = Date.now();
  const wanted = tasks
    .filter(t => t.remind && !t.done && t.due != null && reminderAt(t.due) > now)
    .sort((a, b) => a.due! - b.due!)
    .slice(0, MAX);
  for (const n of await Notifications.getAllScheduledNotificationsAsync()) {
    if (n.identifier.startsWith(PREFIX)) await Notifications.cancelScheduledNotificationAsync(n.identifier);
  }
  if (!wanted.length) return;
  let perm = await Notifications.getPermissionsAsync();
  if (!perm.granted && perm.canAskAgain) perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) return;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('reminders', { name: 'Reminders', importance: Notifications.AndroidImportance.HIGH });
  }
  for (const t of wanted) {
    await Notifications.scheduleNotificationAsync({
      identifier: `${PREFIX}${t.id}`,
      content: { title: t.title, body: t.list === 'Work' ? 'Work reminder from Bibbly' : 'Reminder from Bibbly', data: { taskId: t.id } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(reminderAt(t.due!)), channelId: 'reminders' },
    });
  }
}
