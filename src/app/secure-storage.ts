import { Capacitor, registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

interface SecureStoragePlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

const SecureStorage = registerPlugin<SecureStoragePlugin>('TaskFlowSecureStorage');

function removeLegacyLocalValue(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // localStorage may be disabled.
  }
}

export async function secureGet(key: string): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const { value } = await SecureStorage.get({ key });
    if (value !== null) {
      removeLegacyLocalValue(key);
      await Preferences.remove({ key }).catch(() => undefined);
      return value;
    }

    // One-time migration from the former unencrypted Preferences storage.
    const legacy = await Preferences.get({ key });
    if (legacy.value !== null) {
      await SecureStorage.set({ key, value: legacy.value });
      await Preferences.remove({ key });
    }
    removeLegacyLocalValue(key);
    return legacy.value;
  } catch {
    removeLegacyLocalValue(key);
    return null;
  }
}

export async function secureSet(key: string, value: string | null): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (value === null) {
    await Promise.allSettled([
      SecureStorage.remove({ key }),
      Preferences.remove({ key }),
    ]);
    removeLegacyLocalValue(key);
    return;
  }
  await SecureStorage.set({ key, value });
  await Preferences.remove({ key }).catch(() => undefined);
  removeLegacyLocalValue(key);
}

export async function secureRemove(key: string): Promise<void> {
  await secureSet(key, null);
}
