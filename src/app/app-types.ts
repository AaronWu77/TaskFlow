import type { PendingSyncOperationDTO, TaskDTO } from './api';

export type Priority = 'P1' | 'P2' | 'P3';
export type TaskStatus = 'todo' | 'done' | 'skipped';
export type ViewMode = 'flow' | 'calendar';
export type ExitAction = 'complete' | 'skip' | 'snooze';
export type TaskActionState = { taskId: string; action: ExitAction };
export type NotificationPermissionState = 'unsupported' | 'prompt' | 'granted' | 'denied';

export interface Task {
  id: string;
  title: string;
  priority: Priority;
  estimateMinutes: number | null;
  progress?: number;
  status: TaskStatus;
  tag?: string | null;
  dueDate?: string | null;
  reminderAt?: string | null;
  repeatRule?: 'none' | 'daily' | 'weekly' | 'monthly' | null;
  repeatUntilDate?: string | null;
  seriesId?: string | null;
  seriesVersion?: number | null;
  occurrenceDate?: string | null;
  completedAt?: string | null;
  deletedAt?: string | null;
  sortOrder: number;
  version?: number;
  lastChangedByDeviceId?: string | null;
  updatedAt?: string;
  _dirty?: boolean;
  _syncState?: 'create' | 'update' | 'permanent-delete';
  _operationId?: string;
  _conflict?: boolean;
  _syncError?: boolean;
  _clientKey?: string;
}

export type SyncMeta = {
  syncCursor: number;
  lastSuccessfulSyncAt: string;
  taskOrderVersion: number;
  protocolVersion: number;
  snapshotId: string;
};

export type ConflictType = 'field' | 'delete-edit' | 'order' | 'permanent-delete' | 'series';
export type PendingOperation = PendingSyncOperationDTO & {
  createdAt: string;
  retryCount: number;
  status: 'pending' | 'conflict' | 'failed';
  conflictType?: ConflictType;
  serverTask?: TaskDTO;
  serverTasks?: TaskDTO[];
  serverVersion?: number;
  serverOrderVersion?: number;
  serverOrder?: Array<{ id: string; sortOrder: number }>;
  clientPayload?: unknown;
  baseTaskSnapshot?: Record<string, unknown>;
  conflictedFields?: string[];
  detectedAt?: string;
};
