import type { ReactNode } from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { radius, useTheme } from '../theme';
import { Icon } from './Icon';
import { Mascot, type MascotState } from './Mascot';

export function Screen({ children, scroll = true, padded = true }: { children: ReactNode; scroll?: boolean; padded?: boolean }) {
  const t = useTheme();
  const body = <View style={[padded && styles.padded, { gap: 16 }]}>{children}</View>;
  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: t.bg }}>
      {scroll ? <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">{body}</ScrollView> : body}
    </SafeAreaView>
  );
}

export function Title({ eyebrow, children, right }: { eyebrow?: string; children: ReactNode; right?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={styles.titleRow}>
      <View style={{ flex: 1 }}>
        {eyebrow ? <Text style={[styles.eyebrow, { color: t.lagoon }]}>{eyebrow}</Text> : null}
        <Text accessibilityRole="header" style={[styles.h1, { color: t.ink }]}>{children}</Text>
      </View>
      {right}
    </View>
  );
}

export function H2({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text accessibilityRole="header" style={[styles.h2, { color: t.ink }]}>{children}</Text>;
}

export function Body({ children, muted, small, style }: { children: ReactNode; muted?: boolean; small?: boolean; style?: StyleProp<any> }) {
  const t = useTheme();
  return <Text style={[{ color: muted ? t.ink2 : t.ink, fontSize: small ? 13 : 15, lineHeight: small ? 18 : 21 }, style]}>{children}</Text>;
}

export function Card({ children, style, tone }: { children: ReactNode; style?: StyleProp<ViewStyle>; tone?: 'lagoon' | 'sun' | 'coral' }) {
  const t = useTheme();
  const bg = tone === 'lagoon' ? t.lagoonSoft : tone === 'sun' ? t.sunSoft : tone === 'coral' ? t.coralSoft : t.surface;
  return <View style={[styles.card, { backgroundColor: bg, borderColor: tone ? 'transparent' : t.line }, style]}>{children}</View>;
}

type ButtonKind = 'primary' | 'ghost' | 'danger' | 'soft';
export function Button({ label, onPress, kind = 'ghost', icon, disabled, busy, small, accessibilityHint }: {
  label: string; onPress: () => void; kind?: ButtonKind; icon?: string; disabled?: boolean; busy?: boolean; small?: boolean; accessibilityHint?: string;
}) {
  const t = useTheme();
  const bg = kind === 'primary' ? t.lagoon : kind === 'danger' ? t.coral : kind === 'soft' ? t.lagoonSoft : t.surface;
  const fg = kind === 'primary' ? t.onLagoon : kind === 'danger' ? '#fff' : kind === 'soft' ? t.lagoon : t.ink;
  return (
    <Pressable
      accessibilityRole="button" accessibilityLabel={label} accessibilityHint={accessibilityHint} accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      disabled={disabled || busy} onPress={onPress} hitSlop={6}
      style={({ pressed }) => [styles.button, small && styles.buttonSmall, {
        backgroundColor: bg, borderColor: kind === 'ghost' ? t.line : 'transparent', opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      }]}>
      {busy ? <ActivityIndicator color={fg} size="small" /> : icon ? <Icon n={icon} size={small ? 16 : 18} color={fg} /> : null}
      <Text style={[styles.buttonText, small && { fontSize: 14 }, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

export function IconButton({ icon, label, onPress, color }: { icon: string; label: string; onPress: () => void; color?: string }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={8}
      style={({ pressed }) => [styles.iconButton, { backgroundColor: pressed ? t.fill : 'transparent' }]}>
      <Icon n={icon} size={20} color={color ?? t.ink2} />
    </Pressable>
  );
}

export function Chip({ label, selected, onPress, accessibilityLabel }: { label: string; selected?: boolean; onPress?: () => void; accessibilityLabel?: string }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole={onPress ? 'button' : 'text'} accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ selected: !!selected }}
      onPress={onPress} hitSlop={4}
      style={[styles.chip, { backgroundColor: selected ? t.lagoon : t.surface, borderColor: selected ? t.lagoon : t.line }]}>
      <Text style={{ color: selected ? t.onLagoon : t.ink, fontWeight: '600', fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}

export function Row({ children, gap = 8, wrap, style }: { children: ReactNode; gap?: number; wrap?: boolean; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap, flexWrap: wrap ? 'wrap' : 'nowrap' }, style]}>{children}</View>;
}

export function Field({ label, hint, ...input }: TextInputProps & { label: string; hint?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: t.ink, fontWeight: '600', fontSize: 14 }}>{label}</Text>
      <TextInput
        accessibilityLabel={label} placeholderTextColor={t.ink3}
        style={[styles.input, { color: t.ink, backgroundColor: t.surface2, borderColor: t.line }]}
        {...input}
      />
      {hint ? <Text style={{ color: t.ink3, fontSize: 12.5, lineHeight: 17 }}>{hint}</Text> : null}
    </View>
  );
}

export function Empty({ mascot = 'sleep', title, body, action }: { mascot?: MascotState; title: string; body?: string; action?: ReactNode }) {
  return (
    <View style={{ alignItems: 'center', gap: 8, paddingVertical: 24 }}>
      <Mascot state={mascot} size={110} />
      <H2>{title}</H2>
      {body ? <Body muted style={{ textAlign: 'center', maxWidth: 300 }}>{body}</Body> : null}
      {action}
    </View>
  );
}

export function Banner({ tone = 'sun', children, onClose }: { tone?: 'sun' | 'coral' | 'lagoon'; children: ReactNode; onClose?: () => void }) {
  const t = useTheme();
  return (
    <Card tone={tone} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 12 }}>
      <View style={{ flex: 1 }}><Text style={{ color: tone === 'sun' ? t.sunInk : t.ink, fontSize: 14, lineHeight: 20 }}>{children}</Text></View>
      {onClose ? <IconButton icon="x" label="Dismiss" onPress={onClose} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  padded: { paddingHorizontal: 16, paddingTop: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 12, marginTop: 8 },
  eyebrow: { fontSize: 12.5, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 2 },
  h1: { fontSize: 30, fontWeight: '700', letterSpacing: -0.4 },
  h2: { fontSize: 19, fontWeight: '700' },
  card: { borderRadius: radius.l, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 10 },
  button: { minHeight: 48, borderRadius: 999, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1 },
  buttonSmall: { minHeight: 40, paddingHorizontal: 14 },
  buttonText: { fontSize: 16, fontWeight: '700' },
  iconButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  chip: { minHeight: 40, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, justifyContent: 'center' },
  input: { minHeight: 48, borderRadius: radius.m, borderWidth: 1, paddingHorizontal: 14, fontSize: 16 },
});
