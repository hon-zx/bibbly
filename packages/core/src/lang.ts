import type { LangCode } from './types.js';

export interface LanguageInfo {
  code: LangCode;
  /** English name of the written language. */
  name: string;
  /** Name in the language itself. */
  native: string;
  /** Name of the spoken language, used for "detected" labels. */
  spoken: string;
  /** BCP-47 tag for speech engines (region-qualified). */
  speechTag: string;
  /** BCP-47 tag for HTML lang attributes and Intl. */
  tag: string;
  rtl?: boolean;
}

export const LANGUAGES: readonly LanguageInfo[] = [
  { code: 'en', name: 'English', native: 'English', spoken: 'English', speechTag: 'en-US', tag: 'en' },
  { code: 'zh', name: 'Chinese (Simplified)', native: '简体中文', spoken: 'Mandarin', speechTag: 'zh-CN', tag: 'zh-Hans' },
  { code: 'zh-Hant', name: 'Chinese (Traditional)', native: '繁體中文', spoken: 'Mandarin (Taiwan)', speechTag: 'zh-TW', tag: 'zh-Hant' },
  { code: 'yue', name: 'Cantonese', native: '粵語', spoken: 'Cantonese', speechTag: 'zh-HK', tag: 'zh-Hant-HK' },
  { code: 'ja', name: 'Japanese', native: '日本語', spoken: 'Japanese', speechTag: 'ja-JP', tag: 'ja' },
  { code: 'ko', name: 'Korean', native: '한국어', spoken: 'Korean', speechTag: 'ko-KR', tag: 'ko' },
  { code: 'ms', name: 'Malay', native: 'Bahasa Melayu', spoken: 'Malay', speechTag: 'ms-MY', tag: 'ms' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia', spoken: 'Indonesian', speechTag: 'id-ID', tag: 'id' },
  { code: 'th', name: 'Thai', native: 'ไทย', spoken: 'Thai', speechTag: 'th-TH', tag: 'th' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt', spoken: 'Vietnamese', speechTag: 'vi-VN', tag: 'vi' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी', spoken: 'Hindi', speechTag: 'hi-IN', tag: 'hi' },
  { code: 'es', name: 'Spanish', native: 'Español', spoken: 'Spanish', speechTag: 'es-ES', tag: 'es' },
  { code: 'fr', name: 'French', native: 'Français', spoken: 'French', speechTag: 'fr-FR', tag: 'fr' },
  { code: 'de', name: 'German', native: 'Deutsch', spoken: 'German', speechTag: 'de-DE', tag: 'de' },
  { code: 'pt', name: 'Portuguese', native: 'Português', spoken: 'Portuguese', speechTag: 'pt-BR', tag: 'pt' },
  { code: 'ar', name: 'Arabic', native: 'العربية', spoken: 'Arabic', speechTag: 'ar-SA', tag: 'ar', rtl: true },
  { code: 'ru', name: 'Russian', native: 'Русский', spoken: 'Russian', speechTag: 'ru-RU', tag: 'ru' },
];

const BY_CODE = new Map(LANGUAGES.map(l => [l.code, l]));

export const language = (code: LangCode): LanguageInfo | undefined => BY_CODE.get(code);
export const langName = (code: LangCode): string => BY_CODE.get(code)?.name ?? code;
export const langNative = (code: LangCode): string => BY_CODE.get(code)?.native ?? code;
export const spokenName = (code: LangCode): string => BY_CODE.get(code)?.spoken ?? code.toUpperCase();
export const langTag = (code: LangCode): string => BY_CODE.get(code)?.tag ?? code;
export const speechTag = (code: LangCode): string => BY_CODE.get(code)?.speechTag ?? code;
export const isRtl = (code: LangCode): boolean => !!BY_CODE.get(code)?.rtl;

/** Maps engine tags such as "zh-CN", "cmn-Hans-CN", "ja-JP" or "zh_TW" to Bibbly codes. */
export function normLang(tag: string | null | undefined): LangCode | null {
  if (!tag || typeof tag !== 'string') return null;
  const s = tag.trim().replace('_', '-');
  if (!s) return null;
  if (/^(zh-(TW|Hant)|cmn-Hant)/i.test(s)) return 'zh-Hant';
  if (/^(yue|zh-HK|zh-yue)/i.test(s)) return 'yue';
  if (/^(zh|cmn)/i.test(s)) return 'zh';
  const two = s.slice(0, 2).toLowerCase();
  if (BY_CODE.has(two)) return two;
  const lower = s.toLowerCase();
  return BY_CODE.has(lower) ? lower : lower.split('-')[0] ?? null;
}

/** Fast script-based guess, refined later by the speech engine or Claude. */
export function guessLang(text: string, fallback: LangCode = 'en'): LangCode {
  const t = text || '';
  if (/[぀-ヿ]/.test(t)) return 'ja';
  if (/[가-힯]/.test(t)) return 'ko';
  if (/[一-鿿]/.test(t)) return 'zh';
  if (/[฀-๿]/.test(t)) return 'th';
  if (/[؀-ۿ]/.test(t)) return 'ar';
  if (/[ऀ-ॿ]/.test(t)) return 'hi';
  if (/[Ѐ-ӿ]/.test(t)) return 'ru';
  return /^(zh|zh-Hant|yue|ja|ko|th|ar|hi|ru)$/.test(fallback) ? 'en' : fallback;
}

/**
 * Detects Mandarin–English mixing (e.g. "我们 lock 两个日期"). Capitalised words
 * such as product or place names ("Nimbus Lite") don't count: mixing shows up
 * as ordinary lowercase English words inside a Chinese sentence.
 */
export function guessMixed(text: string): LangCode[] | null {
  const han = /[一-鿿]/.test(text);
  const kana = /[぀-ヿ]/.test(text);
  const lowerWords = (text.match(/\b[a-z]{2,}\b/g) ?? []).length;
  return han && !kana && lowerWords >= 2 ? ['en', 'zh'] : null;
}

/** Label for a detected language, e.g. "Mandarin" or "English + Mandarin". */
export function detectedLabel(lang: LangCode, langs?: LangCode[] | null): string {
  return langs && langs.length > 1 ? langs.map(spokenName).join(' + ') : spokenName(lang);
}
