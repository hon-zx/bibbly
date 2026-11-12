let counter = 0;

/** Short unique id with an optional prefix: "l_m3k9x2a1". */
export function uid(prefix = ''): string {
  counter = (counter + 1) % 1_679_616;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36).padStart(4, '0')}${Math.random().toString(36).slice(2, 5)}`;
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

type Listener<T> = (payload: T) => void;

/** Minimal typed event emitter that works in Node, browsers and React Native. */
export class Emitter<Events extends Record<string, unknown>> {
  private listeners: { [K in keyof Events]?: Set<Listener<Events[K]>> } = {};

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    (this.listeners[event] ??= new Set()).add(fn);
    return () => this.off(event, fn);
  }

  off<K extends keyof Events>(event: K, fn: Listener<Events[K]>): void {
    this.listeners[event]?.delete(fn);
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const fn of [...(this.listeners[event] ?? [])]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bibbly] listener for "${String(event)}" failed`, err);
      }
    }
  }
}

/** Removes control and invisible formatting characters from untrusted display strings. */
export function cleanText(s: unknown, max = 200): string {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .trim()
    .slice(0, max);
}
