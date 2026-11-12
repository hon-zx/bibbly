import type { BibblyApi } from './shared/ipc';

declare global {
  interface Window { bibbly: BibblyApi & { onNavigate(cb: (route: string) => void): () => void } }
}

/** The preload bridge. Every privileged action goes through it. */
export const api = window.bibbly;
