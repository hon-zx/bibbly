/** API keys live in the platform keychain/keystore (expo-secure-store), never in AsyncStorage or the notes. */
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

/** The browser preview has no keychain: keys then live in memory for the session only. */
const keychain = Platform.OS !== 'web';

export type SecretName = 'anthropicKey' | 'whisperKey';

const cache: Partial<Record<SecretName, string>> = {};
let status: Record<SecretName, boolean> = { anthropicKey: false, whisperKey: false };
const listeners = new Set<() => void>();

export async function loadSecrets(): Promise<void> {
  if (keychain) {
    for (const name of ['anthropicKey', 'whisperKey'] as const) {
      try {
        const v = await SecureStore.getItemAsync(name);
        if (v) cache[name] = v;
      } catch (err) {
        console.warn(`[bibbly] could not read ${name} from the keychain`, err);
      }
    }
  }
  refresh();
}

function refresh() {
  status = { anthropicKey: !!cache.anthropicKey, whisperKey: !!cache.whisperKey };
  listeners.forEach(l => l());
}

export const getSecret = (name: SecretName): string | undefined => cache[name];

export async function setSecret(name: SecretName, value: string | null): Promise<void> {
  const v = value?.trim();
  if (v) {
    if (keychain) await SecureStore.setItemAsync(name, v);
    cache[name] = v;
  } else {
    if (keychain) await SecureStore.deleteItemAsync(name);
    delete cache[name];
  }
  refresh();
}

export function useSecretStatus(): Record<SecretName, boolean> {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => status, () => status);
}
