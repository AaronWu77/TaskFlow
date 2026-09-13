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

type DeferredValue = string | (() => string);
type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

const pendingWrites = new Map<string, DeferredValue>();
const nativeWriteChains = new Map<string, Promise<unknown>>();
const reportedStorageErrors = new Set<string>();
let flushHandle: number | null = null;
let flushUsesIdleCallback = false;

function reportStorageError(operation: string, key: string, error: unknown): void {
  const signature = `${operation}:${key}`;
  if (reportedStorageErrors.has(signature)) return;
  reportedStorageErrors.add(signature);
  console.warn('TaskFlow storage operation failed', { operation, key, error });
}

function enqueueNativeWrite(key: string, operation: () => Promise<unknown>): Promise<void> {
  const previous = nativeWriteChains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation).catch(error => {
    reportStorageError('native-write', key, error);
  }).finally(() => {
    if (nativeWriteChains.get(key) === next) nativeWriteChains.delete(key);
  });
  nativeWriteChains.set(key, next);
  return next.then(() => undefined);
}

function flushPendingWrites(): void {
  flushHandle = null;
  const writes = [...pendingWrites.entries()];
  pendingWrites.clear();
  for (const [key, pendingValue] of writes) {
    try {
      const value = typeof pendingValue === 'function' ? pendingValue() : pendingValue;
      localStorage.setItem(key, value);
      enqueueNativeWrite(key, () => Preferences.set({ key, value }));
    } catch (error) {
      reportStorageError('deferred-write', key, error);
    }
  }
}

function scheduleFlush(): void {
  if (flushHandle !== null) return;
  const idleWindow = window as IdleWindow;
  if (typeof idleWindow.requestIdleCallback === 'function') {
    flushUsesIdleCallback = true;
    flushHandle = idleWindow.requestIdleCallback(flushPendingWrites, { timeout: 500 });
  } else {
    flushUsesIdleCallback = false;
    flushHandle = window.setTimeout(flushPendingWrites, 32);
  }
}

/** Synchronous read — always returns immediately (used in React useState initializers). */
export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    reportStorageError('read', key, error);
    return null;
  }
}

/** Write to localStorage (sync) and to Capacitor Preferences (async). */
export function storageSet(key: string, value: string): void {
  pendingWrites.delete(key);
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    reportStorageError('write', key, error);
  }

  enqueueNativeWrite(key, () => Preferences.set({ key, value }));
}

/** Coalesced persistence for frequently changing caches and sync metadata. */
export function storageSetDeferred(key: string, value: DeferredValue): void {
  pendingWrites.set(key, value);
  scheduleFlush();
}

/** Remove from localStorage and Capacitor Preferences. */
export function storageRemove(key: string): void {
  pendingWrites.delete(key);
  try {
    localStorage.removeItem(key);
  } catch (error) {
    reportStorageError('remove', key, error);
  }

  enqueueNativeWrite(key, () => Preferences.remove({ key }));
}

/** Flush queued cache writes before the app is backgrounded or unloaded. */
export async function flushDeferredStorage(): Promise<void> {
  if (flushHandle !== null) {
    const idleWindow = window as IdleWindow;
    if (flushUsesIdleCallback) idleWindow.cancelIdleCallback?.(flushHandle);
    else window.clearTimeout(flushHandle);
  }
  flushPendingWrites();
  while (nativeWriteChains.size > 0) {
    await Promise.all([...nativeWriteChains.values()]);
  }
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
