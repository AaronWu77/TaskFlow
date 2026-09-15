export function classifySyncError(error: unknown): 'conflict' | 'missing' | 'invalid' | 'retryable';
export function syncFailureStatus(error: unknown, online: boolean): 'offline' | 'timeout' | 'incompatible' | 'rateLimited' | 'serviceUnavailable' | 'network';
export function takeSyncBatch<T>(operations: T[], isReady: (operation: T) => boolean, limit?: number, dependencyKey?: (operation: T) => string | null): { batch: T[]; hasMore: boolean };
export function syncRetryDelay(attempt: number, random?: () => number): number;
