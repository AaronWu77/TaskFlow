/**
 * Unified storage layer for TaskFlow.
 *
 * Strategy:
 *  - Reads: always synchronous via localStorage (React can initialize state directly)
 *  - Writes: synchronous to localStorage AND async to Capacitor Preferences
 *    so data survives iOS storage-pressure clearing on physical devices.
 *
 * The Capacitor Preferences plugin is a no-op on web (falls through to localStorage),
 * so this module works identically in the browser and in the native WKWebView.
 */

import { Preferences } from '@capacitor/preferences';

/** Synchronous read — always returns immediately (used in React useState initializers). */
export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Write to localStorage (sync) and to Capacitor Preferences (async). */
export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch { /**/ }

  Preferences.set({ key, value }).catch(() => { /**/ });
}

/** Remove from localStorage and Capacitor Preferences. */
export function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch { /**/ }

  Preferences.remove({ key }).catch(() => { /**/ });
}

/**
 * On native app cold-start, localStorage may have been cleared by iOS.
 * Call this once at startup to restore data from Capacitor Preferences → localStorage.
 * Returns a promise; call it in a useEffect before rendering any persisted state.
 */
export async function restoreFromNativeStorage(keys: string[]): Promise<void> {
  for (const key of keys) {
    try {
      if (localStorage.getItem(key) !== null) continue; // already populated
    } catch {
      // Fall through to Preferences restore path.
    }
    try {
      const { value } = await Preferences.get({ key });
      if (value !== null) {
        try {
          localStorage.setItem(key, value);
        } catch { /**/ }
      }
    } catch { /**/ }
  }
}
