import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { syncReminders } from '../src/reminders';
import { loadSecrets } from '../src/secrets';
import { hydrate, useData, useReady } from '../src/store';
import { useTheme } from '../src/theme';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const ready = useReady();
  const t = useTheme();
  const tasks = useData(d => d.tasks);

  useEffect(() => {
    Promise.all([hydrate(), loadSecrets()]).finally(() => { void SplashScreen.hideAsync(); });
  }, []);

  // Keep the phone's scheduled reminders in step with the task list.
  useEffect(() => {
    if (!ready) return;
    const h = setTimeout(() => { syncReminders(tasks).catch(err => console.warn('[bibbly] reminders', err)); }, 800);
    return () => clearTimeout(h);
  }, [ready, tasks]);

  if (!ready) return null;
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="note/[id]"
          options={{ headerShown: true, title: 'Note', headerTintColor: t.lagoon, headerStyle: { backgroundColor: t.bg }, headerShadowVisible: false, headerTitleStyle: { color: t.ink } }}
        />
      </Stack>
    </SafeAreaProvider>
  );
}
