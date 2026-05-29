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

const IS_NATIVE = typeof (window as unknown as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor !== 'undefined'
  && (window as unknown as { Capacitor: { isNativePlatform: () => boolean } }).Capacitor.isNativePlatform();

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

  if (IS_NATIVE) {
    Preferences.set({ key, value }).catch(() => { /**/ });
  }
}

/**
 * On native app cold-start, localStorage may have been cleared by iOS.
 * Call this once at startup to restore data from Capacitor Preferences → localStorage.
 * Returns a promise; call it in a useEffect before rendering any persisted state.
 */
export async function restoreFromNativeStorage(keys: string[]): Promise<void> {
  if (!IS_NATIVE) return;
  for (const key of keys) {
    if (localStorage.getItem(key) !== null) continue; // already populated
    try {
      const { value } = await Preferences.get({ key });
      if (value !== null) localStorage.setItem(key, value);
    } catch { /**/ }
  }
}
