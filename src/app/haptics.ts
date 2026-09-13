import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';

function runHaptic(action: () => Promise<void>): void {
  if (!Capacitor.isNativePlatform()) return;
  void action().catch(() => {
    // Optional feedback must never block the interaction itself.
  });
}

export function hapticImpactMedium(): void {
  runHaptic(() => Haptics.impact({ style: ImpactStyle.Medium }));
}

export function hapticImpactLight(): void {
  runHaptic(() => Haptics.impact({ style: ImpactStyle.Light }));
}

export function hapticSelectionStart(): void {
  runHaptic(() => Haptics.selectionStart());
}

export function hapticSelectionChanged(): void {
  runHaptic(() => Haptics.selectionChanged());
}

export function hapticSelectionEnd(): void {
  runHaptic(() => Haptics.selectionEnd());
}
