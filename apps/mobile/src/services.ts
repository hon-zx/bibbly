/** Builds the AI services from Settings and the keys in the keychain. */
import { Claude } from '@bibbly/core/claude';
import { WhisperSpeechProvider } from '@bibbly/core/speech/whisper';
import type { SpeechProvider } from '@bibbly/core';
import { File, Paths } from 'expo-file-system';
import { getSecret } from './secrets';
import { getData } from './store';

/** Claude for translation and notes, when the user has added a key. */
export function claude(): Claude | null {
  const key = getSecret('anthropicKey');
  return key ? new Claude({ apiKey: key, model: getData().settings.claudeModel }) : null;
}

let uploads = 0;

/**
 * Speech recognition for live captions and Stick imports. The phone uses any
 * Whisper-compatible server (OpenAI, Groq, or your own faster-whisper), which
 * detects the language of every utterance.
 */
export function speechProvider(): SpeechProvider | null {
  const s = getData().settings;
  if (s.engine !== 'whisper' || !s.whisperUrl) return null;
  const apiKey = getSecret('whisperKey');
  return new WhisperSpeechProvider({
    baseUrl: s.whisperUrl,
    ...(apiKey ? { apiKey } : {}),
    // React Native's FormData sends files by URI, so each utterance goes through a temporary file.
    formFile: async (wav, name) => {
      const file = new File(Paths.cache, `utterance-${Date.now()}-${uploads++ % 8}.wav`);
      await file.write(wav);
      setTimeout(() => { try { file.delete(); } catch { /* already gone */ } }, 60_000);
      return { uri: file.uri, name, type: 'audio/wav' };
    },
  });
}

export const NO_SPEECH_ENGINE = 'Pick a speech engine in Settings to caption live audio. The demo meeting works without one.';
