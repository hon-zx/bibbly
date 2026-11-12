import { useColorScheme } from 'react-native';

/** The same palette as the desktop app (apps/desktop/src/styles.css). */
export const light = {
  bg: '#EDF4F1', surface: '#FFFFFF', surface2: '#F5FAF8', fill: '#E2EEEA', line: '#D2E2DC',
  ink: '#12302C', ink2: '#48635E', ink3: '#6D8580',
  lagoon: '#0A7A69', onLagoon: '#FFFFFF', lagoonSoft: '#D5F1E9',
  coral: '#BF3F2B', coralFill: '#F26B55', coralSoft: '#FCE3DC',
  sun: '#FFC44D', sunSoft: '#FFF1C9', sunInk: '#6B4A00', metal: '#C9D5D2',
  bbBody: '#8BE3CF', bbBelly: '#D7F7EF', bbLine: '#15403B', bbCheek: '#F58F7C',
};
export type Theme = typeof light;

export const dark: Theme = {
  bg: '#0A1618', surface: '#10211F', surface2: '#0D1C1B', fill: '#17302C', line: '#234440',
  ink: '#E2F1EC', ink2: '#A6C2BB', ink3: '#7F9A94',
  lagoon: '#45D3B6', onLagoon: '#04231E', lagoonSoft: '#12362F',
  coral: '#FF907A', coralFill: '#FF7A63', coralSoft: '#3B201B',
  sun: '#FFD067', sunSoft: '#3A3016', sunInk: '#FFE3A3', metal: '#6E807C',
  bbBody: '#86E0CB', bbBelly: '#D2F6EC', bbLine: '#0E2E2A', bbCheek: '#F58F7C',
};

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

export const radius = { l: 22, m: 14, s: 10 };
export const space = (n: number) => n * 4;

/** Speaker colours, cycled per person in a meeting. */
export const SPEAKER_COLORS = { light: ['#0A7A69', '#C24F2A', '#2A62C6', '#9A6410', '#6B5BB0'], dark: ['#45D3B6', '#FF8F6B', '#7EAAFF', '#E8B15C', '#A99BF0'] };
