export function patchTaskDraft<T extends object>(current: T, patch: Partial<T>): T;
export function snapshotTaskDraft<T extends object>(current: T): T;
export function taskDraftFromFieldValues<T extends object>(
  current: T,
  values: { get(name: string): unknown } | Record<string, unknown>,
): T;
