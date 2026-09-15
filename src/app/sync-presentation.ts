import type { PendingOperation, SyncMeta } from './app-types';

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'network' | 'timeout' | 'serviceUnavailable' | 'incompatible' | 'rateLimited' | 'pending' | 'conflict' | 'error';
export type CloudConnectionIssue = Extract<SyncStatus, 'offline' | 'network' | 'timeout' | 'serviceUnavailable' | 'incompatible' | 'rateLimited'> | null;
export type ConnectivityState = 'online' | 'offline' | 'cloud-unreachable';
export type AuthenticationState = 'authenticated' | 'refreshing' | 'expired' | 'switching-account';
export type QueueState = 'clean' | 'pending' | 'syncing' | 'conflict' | 'failed';
export type SyncStateModel = {
  connectivity: ConnectivityState;
  authentication: AuthenticationState;
  queue: QueueState;
  issue: CloudConnectionIssue;
};

export function createSyncStateModel(
  rawStatus: SyncStatus,
  operations: PendingOperation[],
  cloudSyncEnabled: boolean,
  connectionIssue: CloudConnectionIssue,
  online: boolean,
): SyncStateModel {
  const issue = connectionIssue
    ?? (['offline', 'network', 'timeout', 'serviceUnavailable', 'incompatible', 'rateLimited'].includes(rawStatus)
      ? rawStatus as CloudConnectionIssue
      : null);
  const connectivity: ConnectivityState = !online
    ? 'offline'
    : issue && issue !== 'offline' ? 'cloud-unreachable' : 'online';
  const authentication: AuthenticationState = cloudSyncEnabled ? 'authenticated' : 'refreshing';
  const queue: QueueState = operations.some(operation => operation.status === 'conflict')
    ? 'conflict'
    : operations.some(operation => operation.status === 'failed') || rawStatus === 'error'
      ? 'failed'
      : rawStatus === 'syncing'
        ? 'syncing'
        : operations.some(operation => operation.status === 'pending')
          ? 'pending'
          : 'clean';
  return { connectivity, authentication, queue, issue };
}

export function visibleSyncStatus(model: SyncStateModel, meta: SyncMeta): SyncStatus {
  if (model.queue === 'conflict') return 'conflict';
  if (model.queue === 'failed') return 'error';
  if (model.connectivity === 'offline') return model.queue === 'clean' ? 'idle' : 'offline';
  if (model.connectivity === 'cloud-unreachable') return model.issue ?? 'network';
  if (model.authentication !== 'authenticated') return model.issue ?? 'serviceUnavailable';
  if (model.queue === 'syncing') return 'syncing';
  if (model.queue === 'pending') return 'pending';
  if (!meta.lastSuccessfulSyncAt) return 'pending';
  return 'idle';
}
