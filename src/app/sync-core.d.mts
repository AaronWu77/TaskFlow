export type SyncTask = {
  id: string;
  updatedAt?: string;
  completedAt?: string | null;
  _dirty?: boolean;
  _syncState?: string;
  _operationId?: string;
  _clientKey?: string;
  _conflict?: boolean;
  _syncError?: boolean;
};

export function classifySyncError(error: unknown): 'conflict' | 'missing' | 'invalid' | 'retryable';
export function createSingleFlight<T>(operation: () => Promise<T> | T): () => Promise<T>;
export function logoutBlockReason(tasks: SyncTask[], cloudSyncEnabled: boolean): 'offline' | 'pending' | null;
export function mergeFlushResult<T extends SyncTask>(current: T[], before: T[], flushed: T[]): T[];
