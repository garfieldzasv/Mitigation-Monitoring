/**
 * Per-viewer view preferences in localStorage (a replay window's length, the timeline's folded
 * sections). A convenience only: storage can be blocked or cleared, so reads fall back and writes
 * may be lost.
 */

export function readPreference<T>(key: string, fallback: T, valid: (v: unknown) => boolean): T {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return valid(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writePreference(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // a convenience only
  }
}
