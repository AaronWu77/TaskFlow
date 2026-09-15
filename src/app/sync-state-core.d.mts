export type DecodedSyncState<T = unknown> = { revision: number; payload: T };
export function encodeSyncState(payload: unknown, revision: number): string;
export function decodeSyncState<T = unknown>(raw: string | null): DecodedSyncState<T> | null;
export function selectNewestSyncState<T = unknown>(firstRaw: string | null, secondRaw: string | null): DecodedSyncState<T> | null;
