/**
 * Streams the phone's microphone to JavaScript as 16 kHz mono PCM, 100 ms at a
 * time, for live captions. Native code: ios/BibblyAudioModule.swift
 * (AVAudioEngine) and android/.../BibblyAudioModule.kt (AudioRecord).
 *
 * Needs a development build (expo run:ios / run:android or EAS); in Expo Go the
 * module is missing and `micAvailable` is false.
 */
import { NativeModule, requireOptionalNativeModule, type EventSubscription } from 'expo';

export interface FramesEvent {
  /** Base64 of little-endian 16-bit mono samples. */
  pcm: string;
  sampleRate: number;
}

type BibblyAudioEvents = {
  onFrames(event: FramesEvent): void;
  onError(event: { message: string }): void;
};

declare class BibblyAudioModule extends NativeModule<BibblyAudioEvents> {
  start(sampleRate: number): Promise<void>;
  stop(): Promise<void>;
  isRecording(): boolean;
}

const native = requireOptionalNativeModule<BibblyAudioModule>('BibblyAudio');

export const micAvailable = native != null;

function need(): BibblyAudioModule {
  if (!native) throw new Error('Live captions need the Bibbly app build (the microphone module is missing in Expo Go).');
  return native;
}

export const startMic = (sampleRate = 16_000): Promise<void> => need().start(sampleRate);
export const stopMic = async (): Promise<void> => { if (native) await native.stop(); };
export const isMicRecording = (): boolean => native?.isRecording() ?? false;
export const addFramesListener = (cb: (e: FramesEvent) => void): EventSubscription => need().addListener('onFrames', cb);
export const addErrorListener = (cb: (e: { message: string }) => void): EventSubscription => need().addListener('onError', cb);
