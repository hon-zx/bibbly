import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '../../src/ui/Icon';
import { useTheme } from '../../src/theme';

export default function TabsLayout() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const icon = (n: string) => ({ color }: { color: ColorValue }) => <Icon n={n} color={typeof color === 'string' ? color : t.ink3} size={23} />;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.lagoon,
        tabBarInactiveTintColor: t.ink3,
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.line, height: 60 + insets.bottom, paddingTop: 6, paddingBottom: insets.bottom + 6 },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
      }}>
      <Tabs.Screen name="index" options={{ title: 'Live', tabBarIcon: icon('mic') }} />
      <Tabs.Screen name="notes" options={{ title: 'Notes', tabBarIcon: icon('notes') }} />
      <Tabs.Screen name="tasks" options={{ title: 'Tasks', tabBarIcon: icon('check') }} />
      <Tabs.Screen name="stick" options={{ title: 'Stick', tabBarIcon: icon('usb') }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: icon('settings') }} />
    </Tabs>
  );
}
