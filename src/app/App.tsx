import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence, MotionConfig, useReducedMotion } from 'motion/react';
import {
  Check, X, Clock, Plus, Flame, CheckCircle2,
  Calendar, Tag, XCircle, ChevronLeft, ChevronRight,
  ListTodo, SkipForward, AlarmClock, RotateCcw,
  GripVertical, ArrowUpDown, Globe, ChevronUp, ChevronDown,
  Search, Bell, RotateCw, Flag, SlidersHorizontal
} from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { storageGet, storageSet, storageRemove, restoreFromNativeStorage } from './storage';
import { AuthPage } from './AuthPage';
import { apiLogout, clearLocalAuthTokens, setAuthFailureHandler, apiGetUserStats, apiUpdateUserStats, apiRefreshDetailed, getRefreshedUser, apiDeleteAccount, apiSyncBootstrap, apiPullChanges, apiPushOperations, type AuthUser, type TaskDTO, type PendingSyncOperationDTO, type SyncChangeDTO } from './api';
import { toast, Toaster } from 'sonner';
import { cn } from './components/ui/utils';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

// --- Types ---
type Priority = 'P1' | 'P2' | 'P3';
type TaskStatus = 'todo' | 'doing' | 'done' | 'snoozed' | 'skipped';
type ViewMode = 'flow' | 'calendar';
type AppState = 'loading' | 'auth' | 'app';
type ExitAction = 'complete' | 'skip' | 'snooze';
type TaskActionState = { taskId: string; action: ExitAction };
type NotificationPermissionState = 'unsupported' | 'prompt' | 'granted' | 'denied';
type SyncStatus = 'idle' | 'syncing' | 'offline' | 'pending' | 'conflict' | 'error';

interface Task {
  id: string;
  title: string;
  priority: Priority;
  estimateMinutes: number | null;
  status: TaskStatus;
  tag?: string | null;
  dueDate?: string | null;
  reminderAt?: string | null;
  repeatRule?: 'none' | 'daily' | 'weekly' | 'monthly' | null;
  repeatUntilDate?: string | null;
  completedAt?: string | null;
  deletedAt?: string | null;
  sortOrder: number;
  version?: number;
  lastChangedByDeviceId?: string | null;
  updatedAt?: string;
  _dirty?: boolean; // local-only: true if pending sync to server
  _syncState?: 'create' | 'update' | 'permanent-delete'; // local-only: operation to replay
  _operationId?: string; // local-only: stable idempotency key for retries
  _conflict?: boolean; // local-only: true when server rejected update due to a newer version
  _syncError?: boolean; // local-only: non-retryable operation needs a new user edit
  _clientKey?: string; // local-only: stable reference while a local id is replaced during sync
}

// Sync metadata
type SyncMeta = { syncCursor: number; lastSuccessfulSyncAt: string; taskOrderVersion: number };
type ConflictType = 'field' | 'delete-edit' | 'order' | 'permanent-delete';
type PendingOperation = PendingSyncOperationDTO & {
  createdAt: string;
  retryCount: number;
  status: 'pending' | 'conflict' | 'failed';
  conflictType?: ConflictType;
  serverTask?: TaskDTO;
  serverVersion?: number;
  serverOrderVersion?: number;
  clientPayload?: unknown;
  baseTaskSnapshot?: Record<string, unknown>;
  conflictedFields?: string[];
  detectedAt?: string;
};

function visibleSyncStatus(rawStatus: SyncStatus, operations: PendingOperation[], meta: SyncMeta, cloudSyncEnabled: boolean): SyncStatus {
  if (!cloudSyncEnabled) return 'idle';
  if (operations.some(operation => operation.status === 'conflict')) return 'conflict';
  if (operations.some(operation => operation.status === 'failed')) return 'error';
  if (rawStatus === 'error') return 'error';
  if (rawStatus === 'offline') return 'offline';
  if (operations.some(operation => operation.status === 'pending')) {
    if (rawStatus === 'syncing') return 'syncing';
    return navigator.onLine ? 'pending' : 'offline';
  }
  if (rawStatus === 'syncing') return 'syncing';
  if (!meta.lastSuccessfulSyncAt) return navigator.onLine ? 'pending' : 'offline';
  if (rawStatus === 'conflict' || rawStatus === 'error' || rawStatus === 'offline') return rawStatus;
  return 'idle';
}
const SESSION_KEY = 'taskflow_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type SessionMeta = {
  userId: string;
  email: string;
  emailVerifiedAt?: string | null;
  signedOut: boolean;
  lastAuthenticatedAt: string;
};

function userStorageKey(userId: string, name: string): string {
  return `taskflow:${userId}:${name}`;
}

function legacySessionEmail(): string {
  return storageGet('taskflow_user_email') || '';
}

function migrateLegacyCacheForUser(userId: string): void {
  const migrations: Array<{ legacyKey: string; scopedKey: string }> = [
    { legacyKey: 'taskflow_tasks', scopedKey: userStorageKey(userId, 'tasks') },
    { legacyKey: 'taskflow_streak', scopedKey: userStorageKey(userId, 'streak') },
    { legacyKey: 'taskflow_completed_today', scopedKey: userStorageKey(userId, 'completed_today') },
    { legacyKey: 'taskflow_sync_meta', scopedKey: userStorageKey(userId, 'sync_meta') },
  ];
  for (const { legacyKey, scopedKey } of migrations) {
    const legacyValue = storageGet(legacyKey);
    if (legacyValue !== null && storageGet(scopedKey) === null) {
      storageSet(scopedKey, legacyValue);
    }
  }
}

function clearUserLocalCache(userId: string): void {
  storageRemove(userStorageKey(userId, 'tasks'));
  storageRemove(userStorageKey(userId, 'streak'));
  storageRemove(userStorageKey(userId, 'completed_today'));
  storageRemove(userStorageKey(userId, 'sync_meta'));
  storageRemove(userStorageKey(userId, 'pending_operations'));
}

function loadSession(): SessionMeta | null {
  try {
    const raw = storageGet(SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SessionMeta>;
      // Accept session even with empty email if signedOut flag is present
      if (parsed.signedOut === true) {
        return {
          userId: typeof parsed.userId === 'string' ? parsed.userId : '',
          email: parsed.email || '',
          emailVerifiedAt: typeof parsed.emailVerifiedAt === 'string' ? parsed.emailVerifiedAt : null,
          signedOut: true,
          lastAuthenticatedAt: parsed.lastAuthenticatedAt || new Date().toISOString(),
        };
      }
      if (parsed.userId && parsed.email && parsed.lastAuthenticatedAt) {
        return {
          userId: parsed.userId,
          email: parsed.email,
          emailVerifiedAt: typeof parsed.emailVerifiedAt === 'string' ? parsed.emailVerifiedAt : null,
          signedOut: parsed.signedOut === true,
          lastAuthenticatedAt: parsed.lastAuthenticatedAt,
        };
      }
    }
  } catch { /**/ }
  return null;
}

function saveSession(user: AuthUser): void {
  migrateLegacyCacheForUser(user.id);
  storageSet(SESSION_KEY, JSON.stringify({
    userId: user.id,
    email: user.email,
    emailVerifiedAt: user.emailVerifiedAt ?? null,
    signedOut: false,
    lastAuthenticatedAt: new Date().toISOString(),
  } satisfies SessionMeta));
  storageSet('taskflow_logged_in', '1');
  storageSet('taskflow_user_email', user.email);
}

function clearSession(): void {
  storageSet(SESSION_KEY, JSON.stringify({
    userId: '',
    email: '',
    emailVerifiedAt: null,
    signedOut: true,
    lastAuthenticatedAt: new Date().toISOString(),
  } satisfies SessionMeta));
  storageRemove('taskflow_logged_in');
  storageRemove('taskflow_user_email');
}

function isSessionExpired(session: SessionMeta): boolean {
  const last = new Date(session.lastAuthenticatedAt).getTime();
  return Number.isNaN(last) || Date.now() - last > SESSION_TTL_MS;
}

function loadSyncMeta(userId: string): SyncMeta {
  try {
    const raw = storageGet(userStorageKey(userId, 'sync_meta'));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SyncMeta> & { lastSync?: string };
      return {
        syncCursor: Number.isInteger(parsed.syncCursor) ? parsed.syncCursor as number : 0,
        lastSuccessfulSyncAt: parsed.lastSuccessfulSyncAt || parsed.lastSync || '',
        taskOrderVersion: Number.isInteger(parsed.taskOrderVersion) ? parsed.taskOrderVersion as number : 1,
      };
    }
  } catch { /**/ }
  return { syncCursor: 0, lastSuccessfulSyncAt: '', taskOrderVersion: 1 };
}

function saveSyncMeta(userId: string, meta: SyncMeta) {
  storageSet(userStorageKey(userId, 'sync_meta'), JSON.stringify(meta));
}

function loadPendingOperations(userId: string): PendingOperation[] {
  try {
    const raw = storageGet(userStorageKey(userId, 'pending_operations'));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((operation): operation is PendingOperation =>
      !!operation
      && typeof operation === 'object'
      && typeof (operation as PendingOperation).operationId === 'string'
      && typeof (operation as PendingOperation).type === 'string'
    );
  } catch { /**/ }
  return [];
}

function savePendingOperations(userId: string, operations: PendingOperation[]) {
  storageSet(userStorageKey(userId, 'pending_operations'), JSON.stringify(operations));
}

function getDeviceId(userId: string): string {
  const key = userStorageKey(userId, 'device_id');
  const existing = storageGet(key);
  if (existing) return existing;
  const next = `device-${syncOperationId()}`;
  storageSet(key, next);
  return next;
}

function isLocalTaskId(id: string | null | undefined): boolean {
  return !!id && id.startsWith('local-');
}

function hasOrderPayload(payload: unknown): payload is { order: Array<{ id: string; sortOrder: number }> } {
  return !!payload
    && typeof payload === 'object'
    && Array.isArray((payload as { order?: unknown }).order);
}

function isOperationReady(operation: PendingOperation): boolean {
  if (operation.type === 'create') return true;
  if (isLocalTaskId(operation.taskId)) return false;
  if (hasOrderPayload(operation.payload)) {
    return !operation.payload.order.some(item => isLocalTaskId(item.id));
  }
  return true;
}

function remapOperationIds(operation: PendingOperation, replacements: Map<string, string>): PendingOperation {
  const nextTaskId = operation.taskId && replacements.has(operation.taskId)
    ? replacements.get(operation.taskId)
    : operation.taskId;
  const nextPayload = hasOrderPayload(operation.payload)
    ? {
      ...operation.payload,
      order: operation.payload.order.map(item => ({
        ...item,
        id: replacements.get(item.id) ?? item.id,
      })),
    }
    : operation.payload;
  return {
    ...operation,
    taskId: nextTaskId,
    payload: nextPayload,
  };
}

function removeTaskFromOperation(operation: PendingOperation, taskId: string): PendingOperation | null {
  if (operation.taskId === taskId || operation.clientTaskId === taskId) return null;
  if (hasOrderPayload(operation.payload)) {
    return {
      ...operation,
      payload: {
        ...operation.payload,
        order: operation.payload.order.filter(item => item.id !== taskId),
      },
    };
  }
  return operation;
}

/** Mark a task as dirty (in-memory only — cache save via useEffect) */
function markDirty(tasks: Task[], id: string, syncState: Task['_syncState'] = 'update', operationId?: string): Task[] {
  return tasks.map(t => t.id === id ? { ...t, _dirty: true, _conflict: false, _syncError: false, _operationId: operationId || t._operationId || syncOperationId(), _syncState: t.id.startsWith('local-') ? 'create' : syncState } : t);
}

function syncOperationId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `op-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function taskPatch(t: Task) {
  return {
    title: t.title,
    priority: t.priority,
    estimateMinutes: t.estimateMinutes,
    status: t.status,
    tag: t.tag,
    dueDate: t.dueDate,
    reminderAt: t.reminderAt,
    repeatRule: t.repeatRule,
    repeatUntilDate: t.repeatUntilDate,
    deletedAt: t.deletedAt,
    sortOrder: t.sortOrder,
  };
}

const MERGE_FIELDS = [
  'title',
  'priority',
  'estimateMinutes',
  'status',
  'tag',
  'dueDate',
  'reminderAt',
  'repeatRule',
  'repeatUntilDate',
  'deletedAt',
] as const;

type MergeField = typeof MERGE_FIELDS[number];

const FIELD_LABEL_KEY: Record<MergeField, string> = {
  title: 'task.taskName',
  priority: 'task.priority',
  estimateMinutes: 'task.estMinutes',
  status: 'account.syncStatus',
  tag: 'task.categoryTag',
  dueDate: 'task.deadline',
  reminderAt: 'task.reminderAt',
  repeatRule: 'task.repeatRule',
  repeatUntilDate: 'task.repeatUntilDate',
  deletedAt: 'task.recentlyDeleted',
};

function isMergeField(value: string): value is MergeField {
  return (MERGE_FIELDS as readonly string[]).includes(value);
}

function payloadObject(payload: unknown): Record<string, unknown> {
  return !!payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

function taskFieldValue(task: Task | TaskDTO | Record<string, unknown> | null | undefined, field: MergeField): unknown {
  return task ? (task as unknown as Record<MergeField, unknown>)[field] ?? null : null;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return (left ?? null) === (right ?? null);
}

function conflictFieldsFor(operation: PendingSyncOperationDTO & { baseTaskSnapshot?: Record<string, unknown> }, serverTask?: TaskDTO): MergeField[] {
  if (!serverTask) return [];
  const payload = payloadObject(operation.payload);
  return Object.keys(payload)
    .filter(isMergeField)
    .filter(field => !valuesEqual(payload[field], taskFieldValue(serverTask, field)))
    .filter(field => !operation.baseTaskSnapshot || !valuesEqual(taskFieldValue(serverTask, field), taskFieldValue(operation.baseTaskSnapshot, field)));
}

function conflictTypeFor(code: string, operation: PendingSyncOperationDTO, serverTask?: TaskDTO): ConflictType {
  if (code === 'ORDER_CONFLICT' || operation.type === 'reorder') return 'order';
  if (serverTask?.deletedAt && (operation.type === 'update' || operation.type === 'resolve-conflict')) return 'delete-edit';
  if (code === 'TASK_NOT_FOUND') return 'permanent-delete';
  return 'field';
}

function estimateLabel(minutes: number | null | undefined): string {
  return Number.isInteger(minutes) && (minutes as number) > 0 ? `${minutes}m` : '--m';
}

function dateFromDateOnly(value: string): Date | null {
  const parsed = new Date(`${value}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateOnlyKey(date: Date): string {
  return fmtDate(date.getFullYear(), date.getMonth(), date.getDate());
}

function relativeDueLabel(dueDate: string | null | undefined, t: (key: string) => string, locale: string): string | null {
  if (!dueDate) return null;
  const due = dateFromDateOnly(dueDate);
  if (!due) return dueDate;
  const today = new Date();
  const todayKey = dateOnlyKey(today);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = dateOnlyKey(tomorrow);
  if (dueDate === todayKey) return t('task.dueToday');
  if (dueDate === tomorrowKey) return t('task.dueTomorrow');

  const start = dateFromDateOnly(todayKey);
  if (start) {
    const diffDays = Math.round((due.getTime() - start.getTime()) / 86_400_000);
    if (diffDays > 1 && diffDays < 7) {
      return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'short' }).format(due);
    }
  }
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' }).format(due);
}

function taskTitleClass(title: string): string {
  const length = title.trim().length;
  if (length <= 24) return 'text-[32px]';
  if (length <= 48) return 'text-[28px]';
  return 'text-2xl';
}

function notificationIdForTask(taskId: string): number {
  let hash = 0;
  for (let i = 0; i < taskId.length; i += 1) {
    hash = ((hash << 5) - hash + taskId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash % 1_000_000_000) + 10_000;
}

function canNotifyTask(task: Task): boolean {
  if (!task.reminderAt || task.deletedAt || task.status === 'done' || task.status === 'skipped') return false;
  return new Date(task.reminderAt).getTime() > Date.now();
}

function truncateNotificationText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 3)}...` : trimmed;
}

function notificationDueLabel(task: Task, t: (key: string, options?: Record<string, unknown>) => string, locale: string): string {
  return relativeDueLabel(task.dueDate, (key) => t(key), locale) ?? t('notifications.noDeadline');
}

function notificationCopy(task: Task, t: (key: string, options?: Record<string, unknown>) => string, locale: string) {
  const priority = t(PRIORITY_LABEL_KEY[task.priority]);
  const title = truncateNotificationText(task.title, 42);
  return {
    title: t('notifications.title', { priority }),
    body: t('notifications.body', {
      task: title,
      estimate: estimateLabel(task.estimateMinutes),
      due: notificationDueLabel(task, t, locale),
    }),
  };
}

async function getNotificationPermission(request: boolean): Promise<NotificationPermissionState> {
  if (!Capacitor.isNativePlatform()) return 'unsupported';
  try {
    const current = await LocalNotifications.checkPermissions();
    if (current.display === 'granted') return 'granted';
    if (request && (current.display === 'prompt' || current.display === 'prompt-with-rationale')) {
      const requested = await LocalNotifications.requestPermissions();
      return requested.display === 'granted' ? 'granted' : 'denied';
    }
    return current.display === 'denied' ? 'denied' : 'prompt';
  } catch {
    return 'unsupported';
  }
}

function markOrderDirty(task: Task, sortOrder: number): Task {
  if (task.id.startsWith('local-')) return { ...task, sortOrder };
  return {
    ...task,
    sortOrder,
    _dirty: true,
    _syncState: 'update',
    _operationId: syncOperationId(),
    _conflict: false,
    _syncError: false,
  };
}

// --- Constants ---
const PRESET_TAGS = ['Work', 'Personal', 'Study', 'Planning', 'Health', 'Other'];
const STATUSES_FOR_CLIENT = new Set(['todo', 'doing', 'done', 'snoozed', 'skipped']);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const PRIORITY_BADGE = {
  P1: 'text-rose-600 bg-rose-100',
  P2: 'text-amber-600 bg-amber-100',
  P3: 'text-emerald-600 bg-emerald-100',
};
const PRIORITY_LABEL = { P1: 'High Priority', P2: 'Medium Priority', P3: 'Low Priority' };
const PRIORITY_LABEL_KEY: Record<Priority, string> = { P1: 'priority.P1', P2: 'priority.P2', P3: 'priority.P3' };
const DOT_COLOR = { P1: 'bg-rose-500', P2: 'bg-amber-400', P3: 'bg-emerald-500' };
const ACCENT_THEME_KEY = 'taskflow_accent_theme';

type AccentTheme = 'tcx111400' | 'tcx134306' | 'tcx133802' | 'tcx136006' | 'tcx121107';

const ACCENT_THEME_PRESETS: Record<AccentTheme, {
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  ring: string;
}> = {
  tcx111400: {
    primary: '#F3E0D6',
    primaryForeground: '#3f3029',
    secondary: '#fff4ef',
    secondaryForeground: '#6c5043',
    ring: '#F3E0D6',
  },
  tcx134306: {
    primary: '#D3E4F1',
    primaryForeground: '#263947',
    secondary: '#edf6fc',
    secondaryForeground: '#3c5568',
    ring: '#D3E4F1',
  },
  tcx133802: {
    primary: '#DBD2DB',
    primaryForeground: '#3d3340',
    secondary: '#f5eff5',
    secondaryForeground: '#5b4b5f',
    ring: '#DBD2DB',
  },
  tcx136006: {
    primary: '#CAD3C1',
    primaryForeground: '#30392b',
    secondary: '#eff4eb',
    secondaryForeground: '#495640',
    ring: '#CAD3C1',
  },
  tcx121107: {
    primary: '#F0D8CC',
    primaryForeground: '#3e2f28',
    secondary: '#fff2ec',
    secondaryForeground: '#695044',
    ring: '#F0D8CC',
  },
};

function loadAccentTheme(): AccentTheme {
  const raw = storageGet(ACCENT_THEME_KEY);
  if (!raw) return 'tcx111400';
  if (raw in ACCENT_THEME_PRESETS) return raw as AccentTheme;
  return 'tcx111400';
}

function applyAccentTheme(theme: AccentTheme): void {
  const preset = ACCENT_THEME_PRESETS[theme] ?? ACCENT_THEME_PRESETS.tcx111400;
  const root = document.documentElement;
  root.style.setProperty('--primary', preset.primary);
  root.style.setProperty('--primary-foreground', preset.primaryForeground);
  root.style.setProperty('--secondary', preset.secondary);
  root.style.setProperty('--secondary-foreground', preset.secondaryForeground);
  root.style.setProperty('--ring', preset.ring);
}

// --- Translation-aware helpers ---
const PRIORITY_TAGS = ['P1', 'P2', 'P3'] as const;

function getGreeting(t: (key: string) => string): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return t('greeting.morning');
  if (h >= 12 && h < 17) return t('greeting.afternoon');
  if (h >= 17 && h < 21) return t('greeting.evening');
  return t('greeting.night');
}

function syncAppViewportHeight(forceInnerHeight = false) {
  const viewport = window.visualViewport;
  const viewportHeight = forceInnerHeight
    ? window.innerHeight
    : (viewport?.height ?? window.innerHeight);
  const nextHeight = Math.max(320, Math.round(viewportHeight));
  document.documentElement.style.setProperty('--app-vh', `${nextHeight}px`);
}

async function restoreNativeStorageWithTimeout(keys: string[], timeoutMs = 3000): Promise<void> {
  await Promise.race([
    restoreFromNativeStorage(keys),
    new Promise<void>(resolve => window.setTimeout(resolve, timeoutMs)),
  ]);
}

function normalizeCachedTask(task: Task): Task {
  const { progress: _legacyProgress, ...rest } = task as Task & { progress?: unknown };
  return {
    ...rest,
    version: Number.isInteger(rest.version) ? rest.version : 1,
  };
}

function loadTasks(userId: string): Task[] {
  try {
    const raw = storageGet(userStorageKey(userId, 'tasks'));
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.map(task => normalizeCachedTask(task as Task));
    }
  } catch { /**/ }
  return [];
}

function saveTasksToCache(userId: string, tasks: Task[]) {
  try {
    storageSet(userStorageKey(userId, 'tasks'), JSON.stringify(tasks.map(normalizeCachedTask)));
  } catch { /**/ }
}

// --- Persistence helpers ---
const todayStr = () => new Date().toISOString().split('T')[0];

function loadStatsFromCache(userId: string): { streak: number; completedToday: number } {
  let streak = 0, completedToday = 0;
  try {
    const rawS = storageGet(userStorageKey(userId, 'streak'));
    if (rawS) {
      const { count, lastDate } = JSON.parse(rawS) as { count: number; lastDate: string };
      const today = todayStr();
      if (lastDate === today) streak = count;
      else {
        const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
        if (lastDate === yesterday.toISOString().split('T')[0]) streak = count;
      }
    }
    const rawC = storageGet(userStorageKey(userId, 'completed_today'));
    if (rawC) {
      const { date, count } = JSON.parse(rawC) as { date: string; count: number };
      completedToday = date === todayStr() ? count : 0;
    }
  } catch { /**/ }
  return { streak, completedToday };
}

function saveStatsToCache(userId: string, streak: number, completedToday: number, lastDate?: string | null) {
  const today = todayStr();
  storageSet(userStorageKey(userId, 'streak'), JSON.stringify({ count: streak, lastDate: lastDate || today }));
  storageSet(userStorageKey(userId, 'completed_today'), JSON.stringify({ date: today, count: completedToday }));
}

function fmtDate(y: number, m: number, d: number) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function arrayMove<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return items;
  }
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

function quickDueDate(offset: number): string {
  const next = new Date();
  next.setDate(next.getDate() + offset);
  return fmtDate(next.getFullYear(), next.getMonth(), next.getDate());
}

function nextRepeatDate(dueDate: string | null | undefined, rule: Task['repeatRule']): string | null {
  if (!dueDate || !rule || rule === 'none') return null;
  const next = new Date(`${dueDate}T12:00:00`);
  if (Number.isNaN(next.getTime())) return null;
  if (rule === 'daily') next.setDate(next.getDate() + 1);
  if (rule === 'weekly') next.setDate(next.getDate() + 7);
  if (rule === 'monthly') next.setMonth(next.getMonth() + 1);
  return fmtDate(next.getFullYear(), next.getMonth(), next.getDate());
}

function repeatDatesAfterStart(dueDate: string, repeatUntilDate: string, rule: Task['repeatRule']): string[] {
  const dates: string[] = [];
  let next = nextRepeatDate(dueDate, rule);
  while (next && next <= repeatUntilDate) {
    dates.push(next);
    next = nextRepeatDate(next, rule);
  }
  return dates;
}

function repeatInstanceCount(dueDate: string, repeatUntilDate: string, rule: Task['repeatRule']): number {
  if (!dueDate || !repeatUntilDate || !rule || rule === 'none' || repeatUntilDate <= dueDate) return 0;
  return repeatDatesAfterStart(dueDate, repeatUntilDate, rule).length + 1;
}

function buildRepeatedTasks(source: Task, dueDates: string[], sortOrderStart: number): Task[] {
  const now = new Date().toISOString();
  return dueDates.map((dueDate, offset) => ({
    ...source,
    id: localTaskId(),
    _clientKey: syncOperationId(),
    status: 'todo',
    dueDate,
    reminderAt: null,
    deletedAt: null,
    completedAt: null,
    sortOrder: sortOrderStart + offset,
    version: 1,
    updatedAt: now,
    _dirty: true,
    _syncState: 'create',
    _operationId: syncOperationId(),
    _conflict: false,
  }));
}

function localTaskId(): string {
  return `local-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
}

function taskExitMotion(action: ExitAction | null, shouldReduceMotion = false) {
  if (shouldReduceMotion) {
    return {
      opacity: 0,
      transition: { duration: 0.12, ease: 'easeOut' },
    };
  }
  if (action === 'complete') {
    return {
      opacity: 0,
      y: -82,
      x: 0,
      rotate: 0,
      scale: 0.94,
      filter: 'blur(0.5px)',
      transition: { duration: 0.32, ease: [0.16, 1, 0.3, 1] },
    };
  }
  if (action === 'skip') {
    return {
      opacity: 0,
      y: 18,
      x: -132,
      rotate: -4,
      scale: 0.93,
      filter: 'blur(0.5px)',
      transition: { duration: 0.34, ease: [0.2, 0.9, 0.25, 1] },
    };
  }
  if (action === 'snooze') {
    return {
      opacity: 0,
      y: 112,
      x: 72,
      rotate: 3,
      scale: 0.92,
      filter: 'blur(0.5px)',
      transition: { duration: 0.38, ease: [0.22, 1, 0.36, 1] },
    };
  }
  return {
    opacity: 0,
    y: 36,
    scale: 0.96,
    transition: { duration: 0.24, ease: 'easeOut' },
  };
}

// --- Add Task Form state ---
interface AddTaskState {
  title: string;
  minutes: string;
  priority: Priority;
  dueDate: string;
  reminderAt: string;
  repeatRule: 'none' | 'daily' | 'weekly' | 'monthly';
  repeatUntilDate: string;
  tag: string;
}
type AddTaskErrors = Partial<Record<'title' | 'dueDate' | 'minutes' | 'reminderAt' | 'repeatUntilDate', string>>;

function defaultAddTaskForm(): AddTaskState {
  return {
    title: '',
    minutes: '',
    priority: 'P2',
    dueDate: quickDueDate(0),
    reminderAt: '',
    repeatRule: 'none',
    repeatUntilDate: '',
    tag: '',
  };
}

// Returns index at which newTask should be inserted among existing tasks.
// Only compares against 'todo' tasks; preserves manual ordering otherwise.
const PRIORITY_RANK: Record<Priority, number> = { P1: 1, P2: 2, P3: 3 };
function insertIndex(tasks: Task[], newTask: Task): number {
  const idx = tasks.findIndex(t => {
    if (t.status !== 'todo') return false;
    const nd = newTask.dueDate, ed = t.dueDate;
    if (nd && !ed) return true;
    if (!nd && ed) return false;
    if (nd && ed) {
      if (nd < ed) return true;
      if (nd > ed) return false;
    }
    return PRIORITY_RANK[newTask.priority] < PRIORITY_RANK[t.priority];
  });
  return idx === -1 ? tasks.length : idx;
}

// --- View Toggle ---
function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  const { t } = useTranslation();
  return (
    <div className="relative flex items-center bg-muted rounded-full p-1">
      <button
        onClick={() => onChange('flow')}
        className={`relative flex items-center justify-center gap-2 w-32 py-2 text-sm font-semibold rounded-full transition-colors duration-200 ${view === 'flow' ? 'text-foreground' : 'text-muted-foreground'}`}
      >
        {view === 'flow' && (
          <motion.div
            layoutId="view-toggle"
            className="absolute inset-0 bg-card rounded-full shadow-sm border border-border"
            transition={{ type: 'spring', stiffness: 400, damping: 35 }}
          />
        )}
        <span className="relative z-10 flex items-center gap-2"><ListTodo className="w-3.5 h-3.5 flex-shrink-0" />{t('view.flow')}</span>
      </button>
      <button
        onClick={() => onChange('calendar')}
        className={`relative flex items-center justify-center gap-2 w-32 py-2 text-sm font-semibold rounded-full transition-colors duration-200 ${view === 'calendar' ? 'text-foreground' : 'text-muted-foreground'}`}
      >
        {view === 'calendar' && (
          <motion.div
            layoutId="view-toggle"
            className="absolute inset-0 bg-card rounded-full shadow-sm border border-border"
            transition={{ type: 'spring', stiffness: 400, damping: 35 }}
          />
        )}
        <span className="relative z-10 flex items-center gap-2"><Calendar className="w-3.5 h-3.5 flex-shrink-0" />{t('view.calendar')}</span>
      </button>
    </div>
  );
}

// --- Task Card ---
interface TaskCardProps {
  task: Task;
  onAction: (id: string, action: ExitAction) => void;
  pendingAction?: ExitAction | null;
  actionDisabled?: boolean;
  onOpen?: () => void;
}


function TaskCard({ task, onAction, pendingAction = null, actionDisabled = false, onOpen }: TaskCardProps) {
  const { t, i18n } = useTranslation();
  const [pressedAction, setPressedAction] = React.useState<ExitAction | null>(null);
  const visualAction = pendingAction ?? pressedAction;
  const dueLabel = relativeDueLabel(task.dueDate, t, i18n.language);
  const hasEstimate = Number.isInteger(task.estimateMinutes) && (task.estimateMinutes as number) > 0;

  const triggerAction = (e: React.MouseEvent<HTMLButtonElement>, action: ExitAction) => {
    e.preventDefault();
    e.stopPropagation();
    if (actionDisabled) return;
    setPressedAction(action);
    onAction(task.id, action);
  };

  React.useEffect(() => {
    if (!pressedAction) return;
    const timer = window.setTimeout(() => setPressedAction(null), 260);
    return () => window.clearTimeout(timer);
  }, [pressedAction]);

  const actionButtonClass = (action: ExitAction, base: string) => cn(
    'relative overflow-hidden flex min-h-11 items-center justify-center gap-2 rounded-xl font-semibold transition-[background-color,opacity,transform,box-shadow] duration-150 touch-manipulation select-none',
    base,
    visualAction === action && 'translate-y-px scale-[0.98] shadow-inner'
  );

  return (
    <div onClick={onOpen} className="relative w-full h-full bg-card rounded-3xl border border-border/70 flex flex-col overflow-hidden shadow-sm">
      <div className="relative z-10 flex h-full min-h-0 flex-col p-5 sm:p-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <span className={`shrink-0 text-xs font-semibold px-2.5 py-1 rounded-full ${PRIORITY_BADGE[task.priority]}`}>{t(PRIORITY_LABEL_KEY[task.priority])}</span>
          {task.tag && (
            <span className="min-w-0 truncate text-xs font-medium text-muted-foreground flex items-center gap-1 pt-1">
              <Tag className="w-3 h-3 shrink-0" />{task.tag}
            </span>
          )}
        </div>
        <h2
          className={cn('min-h-0 flex-1 overflow-hidden font-bold leading-tight tracking-normal', taskTitleClass(task.title))}
          style={{ display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical' }}
        >
          {task.title}
        </h2>
        <div className="mt-5 flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
            {dueLabel && (
              <span className="inline-flex items-center gap-1.5 font-medium">
                <Calendar className="w-4 h-4" /><span>{dueLabel}</span>
              </span>
            )}
            {hasEstimate && (
              <span className="inline-flex items-center gap-1.5">
                <Clock className="w-4 h-4" /><span>{estimateLabel(task.estimateMinutes)}</span>
              </span>
            )}
          </div>
          <motion.button type="button" aria-disabled={actionDisabled} onClick={(e) => triggerAction(e, 'complete')} className={actionButtonClass('complete', 'relative z-20 w-full bg-primary text-primary-foreground py-4 font-bold text-lg shadow-lg shadow-primary/20 hover:bg-primary/90')} style={{ WebkitTapHighlightColor: 'transparent' }}>
            <span className={cn('absolute inset-0 bg-white/15 opacity-0 transition-opacity duration-150', visualAction === 'complete' && 'opacity-100')} />
            <Check className="relative w-6 h-6" /><span className="relative">{t('task.complete')}</span>
          </motion.button>
          <div className="relative z-20 grid grid-cols-2 gap-2">
            <motion.button type="button" aria-disabled={actionDisabled} onClick={(e) => triggerAction(e, 'snooze')} className={actionButtonClass('snooze', 'text-muted-foreground py-2.5 hover:bg-muted/70')} style={{ WebkitTapHighlightColor: 'transparent' }}>
              <span className={cn('absolute inset-0 bg-foreground/5 opacity-0 transition-opacity duration-150', visualAction === 'snooze' && 'opacity-100')} />
              <AlarmClock className="relative w-4 h-4 shrink-0" /><span className="relative whitespace-normal text-xs leading-tight sm:text-sm">{t('task.snooze')}</span>
            </motion.button>
            <motion.button type="button" aria-disabled={actionDisabled} onClick={(e) => triggerAction(e, 'skip')} className={actionButtonClass('skip', 'text-muted-foreground py-2.5 hover:bg-muted/70')} style={{ WebkitTapHighlightColor: 'transparent' }}>
              <span className={cn('absolute inset-0 bg-foreground/5 opacity-0 transition-opacity duration-150', visualAction === 'skip' && 'opacity-100')} />
              <SkipForward className="relative w-4 h-4 shrink-0" /><span className="relative text-sm">{t('task.skip')}</span>
            </motion.button>
          </div>
        </div>
      </div>
    </div>
  );
}

function QuickCreateDialog({
  open,
  form,
  errors,
  showReminder,
  onClose,
  onSubmit,
  onOpenDetails,
  onFormChange,
  onReminderChange,
  onShowReminderChange,
}: {
  open: boolean;
  form: AddTaskState;
  errors: AddTaskErrors;
  showReminder: boolean;
  onClose: () => void;
  onSubmit: (event: React.FormEvent) => void;
  onOpenDetails: () => void;
  onFormChange: (patch: Partial<AddTaskState>) => void;
  onReminderChange: (value: string) => void;
  onShowReminderChange: (show: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto w-full max-w-md rounded-t-2xl border-x border-t border-border bg-background shadow-2xl focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom">
          <div className="flex items-start justify-between gap-4 px-5 pb-3 pt-5">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-bold">{t('task.quickCreateTitle')}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted-foreground">{t('task.quickCreateDesc')}</Dialog.Description>
            </div>
            <button type="button" onClick={onClose} aria-label={t('task.close')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground">
              <X className="h-5 w-5" />
            </button>
          </div>

          <form onSubmit={onSubmit} className="space-y-4 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <div className="space-y-2">
              <label htmlFor="quick-task-title" className="sr-only">{t('task.taskName')}</label>
              <input
                id="quick-task-title"
                type="text"
                autoFocus
                enterKeyHint="done"
                placeholder={t('task.titlePlaceholder')}
                aria-invalid={!!errors.title}
                className={cn('h-14 w-full border-0 border-b-2 bg-transparent px-0 text-xl font-semibold outline-none placeholder:text-muted-foreground/70 focus:border-primary', errors.title ? 'border-destructive' : 'border-border')}
                value={form.title}
                onChange={(event) => onFormChange({ title: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              {errors.title && <p className="text-xs font-medium text-destructive">{errors.title}</p>}
            </div>

            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              {[
                { key: 'today', value: quickDueDate(0) },
                { key: 'tomorrow', value: quickDueDate(1) },
              ].map(item => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => onFormChange({ dueDate: item.value })}
                  className={cn('flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-semibold', form.dueDate === item.value ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-muted/60 text-muted-foreground')}
                >
                  <Calendar className="h-4 w-4" />{t(`task.quickDate.${item.key}`)}
                </button>
              ))}

              <label className="relative flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/60 px-3 text-sm font-semibold text-muted-foreground focus-within:border-primary/40 focus-within:text-primary">
                <Flag className="h-4 w-4" />
                <span className="sr-only">{t('task.priority')}</span>
                <select
                  aria-label={t('task.priority')}
                  value={form.priority}
                  onChange={(event) => onFormChange({ priority: event.target.value as Priority })}
                  className="appearance-none bg-transparent pr-4 font-semibold outline-none"
                >
                  {(['P1', 'P2', 'P3'] as Priority[]).map(priority => <option key={priority} value={priority}>{t(PRIORITY_LABEL_KEY[priority])}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5" />
              </label>

              <button
                type="button"
                onClick={() => onShowReminderChange(!showReminder)}
                className={cn('flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-semibold', form.reminderAt ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-muted/60 text-muted-foreground')}
              >
                <Bell className="h-4 w-4" />{t('task.reminderAt')}
              </button>
            </div>

            {showReminder && (
              <div className="flex items-center gap-2">
                <label htmlFor="quick-reminder" className="sr-only">{t('task.reminderAt')}</label>
                <input
                  id="quick-reminder"
                  type="datetime-local"
                  value={form.reminderAt}
                  aria-invalid={!!errors.reminderAt}
                  onChange={(event) => onReminderChange(event.target.value)}
                  className={cn('h-11 min-w-0 flex-1 appearance-none rounded-lg border bg-input-background px-3 text-base outline-none focus:ring-2 focus:ring-ring', errors.reminderAt ? 'border-destructive' : 'border-input')}
                />
                {form.reminderAt && (
                  <button type="button" onClick={() => onReminderChange('')} aria-label={t('task.clearReminder')} className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted">
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            )}
            {errors.reminderAt && <p className="text-xs font-medium text-destructive">{errors.reminderAt}</p>}

            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
              <button type="button" onClick={onOpenDetails} className="flex min-h-12 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold text-muted-foreground hover:bg-muted hover:text-foreground">
                <SlidersHorizontal className="h-4 w-4" />{t('task.completeDetails')}
              </button>
              <button type="submit" className="min-h-12 rounded-lg bg-primary px-5 text-base font-bold text-primary-foreground shadow-sm hover:bg-primary/90">
                {t('task.addTask')}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function TaskDetailsSheet({
  open,
  form,
  errors,
  repeatPreviewCount,
  editing,
  repeatMode,
  onClose,
  onSubmit,
  onFormChange,
  onReminderChange,
}: {
  open: boolean;
  form: AddTaskState;
  errors: AddTaskErrors;
  repeatPreviewCount: number;
  editing: boolean;
  repeatMode: boolean;
  onClose: () => void;
  onSubmit: (event: React.FormEvent) => void;
  onFormChange: (patch: Partial<AddTaskState>) => void;
  onReminderChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[min(88dvh,760px)] w-full max-w-md flex-col rounded-t-2xl border-x border-t border-border bg-background shadow-2xl focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom">
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 pb-4 pt-5">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-bold">{editing ? t('task.editTask') : repeatMode ? t('task.repeatModeTitle') : t('task.taskDetails')}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted-foreground">{t('task.detailsDesc')}</Dialog.Description>
            </div>
            <button type="button" onClick={onClose} aria-label={t('task.close')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground">
              <X className="h-5 w-5" />
            </button>
          </div>

          <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
              <div className="space-y-2">
                <label htmlFor="details-title" className="text-sm font-semibold">{t('task.taskName')}</label>
                <input id="details-title" type="text" value={form.title} aria-invalid={!!errors.title} onChange={(event) => onFormChange({ title: event.target.value })} className={cn('h-11 w-full rounded-lg border bg-input-background px-3 text-base outline-none focus:ring-2 focus:ring-ring', errors.title ? 'border-destructive' : 'border-input')} />
                {errors.title && <p className="text-xs font-medium text-destructive">{errors.title}</p>}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <label htmlFor="details-due-date" className="text-sm font-semibold">{t('task.deadline')}</label>
                  <input id="details-due-date" type="date" value={form.dueDate} aria-invalid={!!errors.dueDate} onChange={(event) => onFormChange({ dueDate: event.target.value })} className={cn('h-11 w-full appearance-none rounded-lg border bg-input-background px-3 text-base outline-none focus:ring-2 focus:ring-ring', errors.dueDate ? 'border-destructive' : 'border-input')} />
                  {errors.dueDate && <p className="text-xs font-medium text-destructive">{errors.dueDate}</p>}
                </div>
                <div className="space-y-2">
                  <label htmlFor="details-priority" className="text-sm font-semibold">{t('task.priority')}</label>
                  <select id="details-priority" value={form.priority} onChange={(event) => onFormChange({ priority: event.target.value as Priority })} className="h-11 w-full rounded-lg border border-input bg-input-background px-3 text-base outline-none focus:ring-2 focus:ring-ring">
                    {(['P1', 'P2', 'P3'] as Priority[]).map(priority => <option key={priority} value={priority}>{t(PRIORITY_LABEL_KEY[priority])}</option>)}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <label htmlFor="details-minutes" className="text-sm font-semibold">{t('task.estMinutes')}</label>
                  <input id="details-minutes" type="number" min="1" max="1440" inputMode="numeric" value={form.minutes} aria-invalid={!!errors.minutes} onChange={(event) => onFormChange({ minutes: event.target.value })} className={cn('h-11 w-full rounded-lg border bg-input-background px-3 text-base outline-none focus:ring-2 focus:ring-ring', errors.minutes ? 'border-destructive' : 'border-input')} />
                  {errors.minutes && <p className="text-xs font-medium text-destructive">{errors.minutes}</p>}
                </div>
                <div className="space-y-2">
                  <label htmlFor="details-tag" className="text-sm font-semibold">{t('task.categoryTag')}</label>
                  <select id="details-tag" value={form.tag} onChange={(event) => onFormChange({ tag: event.target.value })} className="h-11 w-full rounded-lg border border-input bg-input-background px-3 text-base outline-none focus:ring-2 focus:ring-ring">
                    <option value="">{t('task.noTag')}</option>
                    {PRESET_TAGS.map(tag => <option key={tag} value={tag}>{t(`tag.${tag}`)}</option>)}
                  </select>
                </div>
              </div>

              <div className="space-y-2">
                <label htmlFor="details-reminder" className="flex items-center gap-2 text-sm font-semibold"><Bell className="h-4 w-4" />{t('task.reminderAt')}</label>
                <input id="details-reminder" type="datetime-local" value={form.reminderAt} aria-invalid={!!errors.reminderAt} onChange={(event) => onReminderChange(event.target.value)} className={cn('h-11 w-full appearance-none rounded-lg border bg-input-background px-3 text-base outline-none focus:ring-2 focus:ring-ring', errors.reminderAt ? 'border-destructive' : 'border-input')} />
                {errors.reminderAt && <p className="text-xs font-medium text-destructive">{errors.reminderAt}</p>}
                <p className="text-xs text-muted-foreground">{t('task.reminderHint')}</p>
              </div>

              <div className="space-y-3 border-t border-border pt-5">
                <div className="space-y-2">
                  <label htmlFor="details-repeat" className="text-sm font-semibold">{t('task.repeatRule')}</label>
                  <select id="details-repeat" value={form.repeatRule} onChange={(event) => {
                    const repeatRule = event.target.value as AddTaskState['repeatRule'];
                    onFormChange({ repeatRule, repeatUntilDate: repeatRule === 'none' ? '' : form.repeatUntilDate });
                  }} className="h-11 w-full rounded-lg border border-input bg-input-background px-3 text-base outline-none focus:ring-2 focus:ring-ring">
                    <option value="none">{t('task.repeatRules.none')}</option>
                    <option value="daily">{t('task.repeatRules.daily')}</option>
                    <option value="weekly">{t('task.repeatRules.weekly')}</option>
                    <option value="monthly">{t('task.repeatRules.monthly')}</option>
                  </select>
                </div>
                {form.repeatRule !== 'none' && (
                  <div className="space-y-2">
                    <label htmlFor="details-repeat-until" className="text-sm font-semibold">{t('task.repeatUntilDate')}</label>
                    <input id="details-repeat-until" type="date" min={form.dueDate || undefined} value={form.repeatUntilDate} aria-invalid={!!errors.repeatUntilDate} onChange={(event) => onFormChange({ repeatUntilDate: event.target.value })} className={cn('h-11 w-full appearance-none rounded-lg border bg-input-background px-3 text-base outline-none focus:ring-2 focus:ring-ring', errors.repeatUntilDate ? 'border-destructive' : 'border-input')} />
                    {errors.repeatUntilDate && <p className="text-xs font-medium text-destructive">{errors.repeatUntilDate}</p>}
                    {repeatPreviewCount > 0 && <p className={cn('rounded-lg px-3 py-2 text-xs leading-relaxed', repeatPreviewCount > 30 ? 'bg-amber-500/10 text-amber-700' : 'bg-muted text-muted-foreground')}>{t('task.repeatPreview', { count: repeatPreviewCount })}</p>}
                    <p className="text-xs text-muted-foreground">{t('task.repeatHint')}</p>
                  </div>
                )}
              </div>
            </div>

            <div className="grid shrink-0 grid-cols-[auto_minmax(0,1fr)] gap-2 border-t border-border bg-background px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3">
              <button type="button" onClick={onClose} className="min-h-12 rounded-lg px-4 text-sm font-semibold text-muted-foreground hover:bg-muted">{t('task.cancel')}</button>
              <button type="submit" className="min-h-12 rounded-lg bg-primary px-5 text-base font-bold text-primary-foreground hover:bg-primary/90">{editing ? t('task.saveChanges') : repeatMode ? t('task.addRepeatedTask') : t('task.addTask')}</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// --- Task Detail Modal (Calendar) ---
function TaskDetailModal({ task, onClose, onAction, actionDisabled = false, onManage }: {
  task: Task | null; onClose: () => void;
  onAction: (id: string, action: ExitAction) => void;
  actionDisabled?: boolean;
  onManage?: (task: Task) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={!!task} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 backdrop-blur-md z-50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-[50%] top-[50%] z-50 w-full max-w-[360px] h-[520px] translate-x-[-50%] translate-y-[-50%] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 rounded-3xl focus:outline-none shadow-2xl">
          <Dialog.Title className="sr-only">{task?.title}</Dialog.Title>
          <Dialog.Description className="sr-only">Task actions</Dialog.Description>
          {task && (
            <TaskCard
              task={task}
              onAction={(id, action) => { onAction(id, action); onClose(); }}
              pendingAction={actionDisabled ? null : undefined}
              actionDisabled={actionDisabled}
            />
          )}
          <Dialog.Close asChild>
            <button aria-label="Close task details" className="absolute -top-1 -right-1 z-20 w-9 h-9 flex items-center justify-center rounded-full bg-card border border-border shadow-sm text-muted-foreground hover:text-foreground transition-colors">
              <X className="w-4 h-4" />
            </button>
          </Dialog.Close>
          {task && onManage && (
            <button
              type="button"
              onClick={() => { onManage(task); onClose(); }}
              className="absolute -bottom-14 left-1/2 z-20 -translate-x-1/2 rounded-full border border-border bg-card px-5 py-2 text-sm font-semibold text-foreground shadow-sm"
            >
              {t('task.manage')}
            </button>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function TaskManageDialog({ task, onClose, onEdit, onDelete }: {
  task: Task | null;
  onClose: () => void;
  onEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={!!task} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 backdrop-blur-md z-50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-[50%] top-[50%] z-50 w-[calc(100%-2rem)] max-w-sm translate-x-[-50%] translate-y-[-50%] rounded-3xl border border-border bg-card p-5 shadow-2xl focus:outline-none">
          <Dialog.Title className="text-base font-bold">{task?.title}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted-foreground">{t('task.manageTaskDesc')}</Dialog.Description>
          {task && (
            <div className="mt-5 space-y-2">
              <button
                type="button"
                onClick={() => { onEdit(task); onClose(); }}
                className="flex w-full items-center justify-center rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground active:scale-95"
              >
                {t('task.editTask')}
              </button>
              <button
                type="button"
                onClick={() => { onDelete(task); onClose(); }}
                className="flex w-full items-center justify-center rounded-xl bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive active:scale-95"
              >
                {t('task.delete')}
              </button>
              <Dialog.Close asChild>
                <button type="button" className="flex w-full items-center justify-center rounded-xl bg-muted px-4 py-3 text-sm font-semibold text-muted-foreground active:scale-95">
                  {t('task.cancel')}
                </button>
              </Dialog.Close>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// --- Repeat Task Modal ---
function RepeatTaskModal({ task, onClose, onRepeat }: {
  task: Task | null; onClose: () => void; onRepeat: (task: Task) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={!!task} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/20 backdrop-blur-md z-50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-[50%] top-[50%] z-50 w-full max-w-sm translate-x-[-50%] translate-y-[-50%] border border-border bg-card rounded-2xl p-6 shadow-xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 focus:outline-none">
          <Dialog.Title className="text-base font-bold mb-1">{t('task.completedTask')}</Dialog.Title>
          <Dialog.Description className="text-sm text-muted-foreground mb-4">{t('task.donePrompt')}</Dialog.Description>
          {task && (
            <>
              <div className="bg-muted/50 rounded-xl p-4 mb-5 space-y-2">
                <p className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />{task.title}
                </p>
                <div className="flex flex-wrap gap-2 ml-6">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${PRIORITY_BADGE[task.priority]}`}>{t(PRIORITY_LABEL_KEY[task.priority])}</span>
                  {task.tag && <span className="text-xs text-muted-foreground flex items-center gap-1"><Tag className="w-3 h-3" />{task.tag}</span>}
                  <span className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" />{estimateLabel(task.estimateMinutes)}</span>
                </div>
              </div>
              <div className="flex gap-3">
                <Dialog.Close asChild>
                  <button className="flex-1 py-2.5 bg-muted text-muted-foreground rounded-xl text-sm font-semibold hover:bg-muted/80 transition-colors">{t('task.cancel')}</button>
                </Dialog.Close>
                <button onClick={() => { onRepeat(task); onClose(); }} className="flex-1 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-primary/90 transition-colors active:scale-95">
                  <RotateCcw className="w-4 h-4" />{t('task.repeatTask')}
                </button>
              </div>
            </>
          )}
          <Dialog.Close asChild>
            <button aria-label="Close repeat task dialog" className="absolute right-4 top-4 opacity-70 transition-opacity hover:opacity-100"><XCircle className="h-4 w-4" /></button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// --- Reorder Row Item (with dedicated drag handle) ---
function ReorderRow({
  task,
  position,
  isFirst,
  isDragging,
  setRowRef,
  onHandlePointerDown,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
}: {
  task: Task;
  position: number;
  isFirst: boolean;
  isDragging: boolean;
  setRowRef: (node: HTMLDivElement | null) => void;
  onHandlePointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const { t } = useTranslation();
  return (
    <motion.div
      ref={setRowRef}
      layout
      className={cn(
        'select-none rounded-2xl border px-3 py-3.5',
        isFirst ? 'border-primary/20 bg-primary/5 shadow-sm' : 'border-border bg-card',
        isDragging && 'relative z-10 border-primary/40 shadow-lg shadow-black/10'
      )}
      animate={{ scale: isDragging ? 1.015 : 1 }}
      transition={isDragging
        ? { type: 'tween', duration: 0.02 }
        : { type: 'spring', stiffness: 420, damping: 34, mass: 0.75 }}
    >
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <button
            onPointerDown={onHandlePointerDown}
            className="-ml-2 -mt-2 touch-none cursor-grab rounded-xl p-3 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:cursor-grabbing"
            aria-label={`Reorder ${task.title}`}
            type="button"
          >
            <GripVertical className="h-5 w-5" />
          </button>
          <div className="mt-1 flex w-8 flex-col items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground tabular-nums">{position}</span>
            <span className={`h-2.5 w-2.5 rounded-full ${DOT_COLOR[task.priority]}`} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-sm font-semibold leading-snug text-foreground">
                {task.title}
              </p>
              {isFirst && (
                <span className="rounded-full bg-primary/10 px-2 py-1 text-[11px] font-semibold text-primary">
                  {t('task.now')}
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded-md bg-muted px-2 py-1">{estimateLabel(task.estimateMinutes)}</span>
              <span className={`rounded-md px-2 py-1 font-semibold ${PRIORITY_BADGE[task.priority]}`}>
                {task.priority}
              </span>
              {task.tag && (
                <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1">
                  <Tag className="h-3 w-3" />
                  {task.tag}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={!canMoveUp}
            aria-label={`Move ${task.title} up`}
            className="rounded-lg border border-border p-1.5 text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={!canMoveDown}
            aria-label={`Move ${task.title} down`}
            className="rounded-lg border border-border p-1.5 text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// --- Reorder Bottom Sheet ---
function ReorderSheet({ isOpen, pendingTasks, onClose, onSave }: {
  isOpen: boolean; pendingTasks: Task[];
  onClose: () => void; onSave: (ordered: Task[]) => void;
}) {
  const { t } = useTranslation();
  const [orderIds, setOrderIds] = useState<string[]>(() => pendingTasks.map(task => task.id));
  const taskById = useMemo(() => new Map(pendingTasks.map(task => [task.id, task])), [pendingTasks]);
  const pendingTaskIds = useMemo(() => pendingTasks.map(task => task.id), [pendingTasks]);
  const pendingTaskIdsKey = pendingTaskIds.join('\u001f');
  const currentOrderKey = orderIds.join('\u001f');
  const order = useMemo(
    () => orderIds.map(id => taskById.get(id)).filter((task): task is Task => !!task),
    [orderIds, taskById]
  );
  const [dragState, setDragState] = useState<{ id: string; startY: number; currentY: number } | null>(null);
  const rowRefs = React.useRef(new Map<string, HTMLDivElement>());
  const lastHapticIndexRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (!isOpen) return;
    setOrderIds(pendingTaskIds);
    setDragState(null);
  }, [isOpen, pendingTaskIdsKey]);

  const hasChanges = currentOrderKey !== pendingTaskIdsKey;
  const leadTask = order[0] ?? null;
  const queuedCount = Math.max(order.length - 1, 0);

  const handleClose = () => {
    setOrderIds(pendingTaskIds);
    setDragState(null);
    onClose();
  };

  const handleDone = () => {
    if (hasChanges) onSave(order);
    onClose();
  };

  const setRowRef = React.useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) rowRefs.current.set(id, node);
    else rowRefs.current.delete(id);
  }, []);

  const moveDraggedId = React.useCallback((dragId: string, pointerY: number) => {
    setOrderIds(prev => {
      if (!prev.includes(dragId)) return prev;
      const withoutDragged = prev.filter(id => id !== dragId);
      let targetIndex = withoutDragged.length;

      for (let i = 0; i < withoutDragged.length; i += 1) {
        const id = withoutDragged[i];
        const row = rowRefs.current.get(id);
        if (!row) continue;
        const rect = row.getBoundingClientRect();
        const centerY = rect.top + rect.height / 2;
        if (pointerY < centerY) {
          targetIndex = i;
          break;
        }
      }

      const next = [...withoutDragged];
      next.splice(targetIndex, 0, dragId);
      const nextKey = next.join('\u001f');
      if (nextKey === prev.join('\u001f')) return prev;

      const nextIndex = next.indexOf(dragId);
      if (lastHapticIndexRef.current !== nextIndex) {
        lastHapticIndexRef.current = nextIndex;
        Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
      }
      return next;
    });
  }, []);

  const moveByStep = React.useCallback((id: string, direction: -1 | 1) => {
    setOrderIds(prev => {
      const currentIndex = prev.indexOf(id);
      const nextIndex = currentIndex + direction;
      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= prev.length) return prev;
      Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
      return arrayMove(prev, currentIndex, nextIndex);
    });
  }, []);

  const startDrag = React.useCallback((id: string, event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragState({ id, startY: event.clientY, currentY: event.clientY });
    lastHapticIndexRef.current = orderIds.indexOf(id);
    Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {});

    const handleMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      setDragState(current => current?.id === id ? { ...current, currentY: moveEvent.clientY } : current);
      moveDraggedId(id, moveEvent.clientY);
    };
    const finishDrag = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
      setDragState(current => current?.id === id ? null : current);
      lastHapticIndexRef.current = null;
      Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
    };

    window.addEventListener('pointermove', handleMove, { passive: false });
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
  }, [moveDraggedId, orderIds]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40"
            onClick={handleClose}
          />
          <motion.div
            key="sheet"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 380, damping: 38, mass: 0.9 }}
            className="fixed bottom-0 left-0 right-0 z-50 bg-card rounded-t-3xl border-t border-border flex flex-col"
            style={{ maxHeight: '82vh' }}
          >
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-muted-foreground/30" />
            </div>

            <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
              <div>
                <h2 className="text-base font-bold">{t('task.reorderTasks')}</h2>
                <p className="text-xs text-muted-foreground mt-0.5">{t('task.reorderHint')}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={handleClose}
                  className="rounded-xl border border-border px-3 py-2 text-sm font-semibold text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                >
                  {t('task.cancel')}
                </button>
                <button
                  onClick={handleDone}
                  className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-transform active:scale-95"
                >
                  <Check className="w-4 h-4" />{t('task.done')}
                </button>
              </div>
            </div>

            <div className="overflow-y-auto flex-1 px-4 py-3">
              {order.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <CheckCircle2 className="w-10 h-10 text-emerald-500 mb-3" />
                  <p className="text-sm text-muted-foreground">{t('task.noPendingTasks')}</p>
                </div>
              ) : (
                <>
                  {leadTask && (
                    <div className="mb-3 rounded-2xl border border-primary/20 bg-primary/5 p-3">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary/80">
                            {t('task.currentFocus')}
                          </p>
                          <p className="mt-1 text-sm font-semibold text-foreground">{leadTask.title}</p>
                        </div>
                        <span className="rounded-full bg-background/80 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                          {t('task.queuedCount', { count: queuedCount })}
                        </span>
                      </div>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t('task.reorderLeadHint')}
                      </p>
                    </div>
                  )}
                  <div className="space-y-2">
                    {order.map((task, index) => (
                      <ReorderRow
                        key={task.id}
                        task={task}
                        position={index + 1}
                        isFirst={index === 0}
                        isDragging={dragState?.id === task.id}
                        setRowRef={(node) => setRowRef(task.id, node)}
                        onHandlePointerDown={(event) => startDrag(task.id, event)}
                        onMoveUp={() => moveByStep(task.id, -1)}
                        onMoveDown={() => moveByStep(task.id, 1)}
                        canMoveUp={index > 0}
                        canMoveDown={index < order.length - 1}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="px-5 py-3 border-t border-border">
              <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
                <p>{order.length} {t('task.tasksInFlow')}</p>
                <p>{hasChanges ? t('task.unsavedChanges') : t('task.orderSaved')}</p>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// --- Calendar View ---
function CalendarView({ tasks, onAction, onAddTask, onRepeatTask, onManageTask, actingTaskIds, showAddTaskPrompt = true, nativeControls = false }: {
  tasks: Task[];
  onAction: (id: string, action: ExitAction) => void;
  onAddTask: () => void;
  onRepeatTask: (task: Task) => void;
  onManageTask?: (task: Task) => void;
  actingTaskIds?: Set<string>;
  showAddTaskPrompt?: boolean;
  nativeControls?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [selectedDate, setSelectedDate] = useState<string | null>(
    fmtDate(today.getFullYear(), today.getMonth(), today.getDate())
  );
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const detailTask = detailTaskId ? tasks.find(t => t.id === detailTaskId) ?? null : null;
  const [repeatTask, setRepeatTask] = useState<Task | null>(null);
  const [query, setQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState<'all' | Priority>('all');
  const [statusFilter, setStatusFilter] = useState<'active' | 'done' | 'skipped' | 'all'>('all');
  const hasCalendarFilters = query.trim().length > 0 || priorityFilter !== 'all' || statusFilter !== 'all';

  const translatedWeekdays = t('calendar.weekdays', { returnObjects: true }) as unknown as string[];
  const translatedMonths = t('calendar.months', { returnObjects: true }) as unknown as string[];

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayFmt = fmtDate(today.getFullYear(), today.getMonth(), today.getDate());

  const visibleTasks = tasks.filter(task => {
    if (task.deletedAt) return false;
    const normalizedQuery = query.trim().toLowerCase();
    const matchesQuery = !normalizedQuery
      || task.title.toLowerCase().includes(normalizedQuery)
      || (task.tag ?? '').toLowerCase().includes(normalizedQuery);
    const matchesPriority = priorityFilter === 'all' || task.priority === priorityFilter;
    const matchesStatus = statusFilter === 'all'
      || (statusFilter === 'active' ? task.status === 'todo' : task.status === statusFilter);
    return matchesQuery && matchesPriority && matchesStatus;
  });

  const allByDate: Record<string, Task[]> = {};
  visibleTasks.forEach(t => { if (t.dueDate) (allByDate[t.dueDate] ??= []).push(t); });

  const prevMonth = () => { month === 0 ? (setYear(y => y - 1), setMonth(11)) : setMonth(m => m - 1); setSelectedDate(null); };
  const nextMonth = () => { month === 11 ? (setYear(y => y + 1), setMonth(0)) : setMonth(m => m + 1); setSelectedDate(null); };

  const dayTasks = selectedDate ? (allByDate[selectedDate] || []) : [];
  const pendingDayTasks = dayTasks.filter(t => t.status === 'todo');
  const doneDayTasks = dayTasks.filter(t => t.status === 'done');
  const skippedDayTasks = dayTasks.filter(t => t.status === 'skipped');

  const cells: Array<number | null> = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <>
      {!nativeControls && (
        <>
          <TaskDetailModal task={detailTask} onClose={() => setDetailTaskId(null)} onAction={onAction} actionDisabled={detailTask ? actingTaskIds?.has(detailTask.id) : false} onManage={onManageTask} />
          <RepeatTaskModal task={repeatTask} onClose={() => setRepeatTask(null)} onRepeat={onRepeatTask} />
        </>
      )}

      <div className="w-full max-w-md space-y-3">
        <div className={cn('bg-card border border-border rounded-2xl shadow-sm overflow-hidden', isSearchOpen ? 'p-2 space-y-2' : 'p-1.5')}>
          {!isSearchOpen ? (
            <button
              type="button"
              onClick={() => setIsSearchOpen(true)}
              className="flex h-9 w-full items-center gap-2 rounded-xl px-3 text-sm font-semibold text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <Search className="w-4 h-4" />
              <span className="flex-1 text-left">{t('task.searchPlaceholder')}</span>
              {(query || priorityFilter !== 'all' || statusFilter !== 'all') && <span className="h-2 w-2 rounded-full bg-primary" />}
              <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('task.searchPlaceholder')}
                  className="h-9 w-full rounded-xl border border-input bg-input-background pl-9 pr-10 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setIsSearchOpen(false)}
                  className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Hide search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
	              <div className="grid grid-cols-2 gap-2">
                <select
                  value={priorityFilter}
                  onChange={(e) => setPriorityFilter(e.target.value as 'all' | Priority)}
                  className="h-8 rounded-lg border border-input bg-input-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="all">{t('task.allPriorities')}</option>
                  <option value="P1">{t('priority.P1')}</option>
                  <option value="P2">{t('priority.P2')}</option>
                  <option value="P3">{t('priority.P3')}</option>
                </select>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as 'active' | 'done' | 'skipped' | 'all')}
                  className="h-8 rounded-lg border border-input bg-input-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="active">{t('view.toDo')}</option>
                  <option value="done">{t('view.completed')}</option>
                  <option value="skipped">{t('task.skipped')}</option>
                  <option value="all">{t('task.allStatuses')}</option>
                </select>
	              </div>
              {hasCalendarFilters && (
                <p className="rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  {t('calendar.filtersActive')}
                </p>
              )}
	            </>
	          )}
	        </div>
        <div className="flex items-center justify-between px-1">
          <button onClick={prevMonth} aria-label="Previous month" className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"><ChevronLeft className="w-5 h-5" /></button>
          <h2 className="text-base font-bold tracking-tight">{translatedMonths[month]} {year}</h2>
          <button onClick={nextMonth} aria-label="Next month" className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"><ChevronRight className="w-5 h-5" /></button>
        </div>

        <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-sm">
          <div className="grid grid-cols-7 border-b border-border">
            {translatedWeekdays.map(d => <div key={d} className="py-2 text-center text-xs font-semibold text-muted-foreground tracking-wide">{d}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((day, idx) => {
              if (day === null) return <div key={`e-${idx}`} className="h-14 border-b border-r border-border/40 last:border-r-0" />;
              const dateStr = fmtDate(year, month, day);
              const dateTasks = allByDate[dateStr] || [];
              const dots = [...new Set(dateTasks.map(t => t.priority))].sort() as Priority[];
              const hasDoneTasks = dateTasks.some(t => t.status === 'done');
              const isToday = dateStr === todayFmt;
              const isSelected = dateStr === selectedDate;
              return (
                <button
                  key={dateStr}
                  onClick={() => setSelectedDate(isSelected ? null : dateStr)}
                  className={`relative h-14 flex flex-col items-center justify-start pt-1.5 border-b border-r border-border/40 transition-colors group ${idx % 7 === 6 ? 'border-r-0' : ''} ${isSelected ? 'bg-primary/[0.07]' : 'hover:bg-muted/60'}`}
                >
                  <span className={`w-7 h-7 flex items-center justify-center rounded-full text-sm font-semibold transition-colors ${isToday ? 'bg-primary text-primary-foreground' : isSelected ? 'text-primary font-bold' : 'text-foreground'}`}>{day}</span>
                  {dots.length > 0 && (
                    <div className="flex items-center gap-0.5 mt-0.5">
                      {dots.map(p => <span key={p} className={`w-1.5 h-1.5 rounded-full ${DOT_COLOR[p]}`} />)}
                      {hasDoneTasks && <CheckCircle2 className="w-2.5 h-2.5 text-emerald-500 ml-0.5" />}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-rose-500" />{t('calendar.high')}</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-400" />{t('calendar.medium')}</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" />{t('calendar.low')}</span>
          <span className="flex items-center gap-1.5 opacity-70"><CheckCircle2 className="w-3 h-3 text-emerald-500" />{t('view.completed')}</span>
        </div>

        <AnimatePresence mode="wait">
          {selectedDate && (
            <motion.div
              key={selectedDate}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="space-y-4"
            >
              <div className="flex items-center justify-between px-1">
                <h3 className="text-sm font-bold text-foreground">
                  {new Date(selectedDate + 'T12:00:00').toLocaleDateString(i18n.language === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
                </h3>
	                <span className="text-xs text-muted-foreground">{t('calendar.taskCount', { count: dayTasks.length })}</span>
              </div>

              {dayTasks.length === 0 ? (
                <div className="bg-card border border-border rounded-2xl p-5 flex flex-col items-center gap-3 text-center">
                  <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center"><Calendar className="w-5 h-5 text-muted-foreground" /></div>
	                  <p className="text-sm text-muted-foreground">{hasCalendarFilters ? t('calendar.noFilteredTasks') : t('task.noTasksScheduled')}</p>
                  {showAddTaskPrompt && (
                    <button onClick={onAddTask} className="text-sm font-semibold text-primary flex items-center gap-1 hover:opacity-80 transition-opacity"><Plus className="w-4 h-4" />{t('task.addTaskPrompt')}</button>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  {pendingDayTasks.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">{t('view.toDo')} — {pendingDayTasks.length}</p>
                      {pendingDayTasks.map((task, i) => (
                        <motion.button key={task.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04, duration: 0.2 }}
                          onClick={() => !nativeControls && setDetailTaskId(task.id)}
                          className={cn('w-full text-left bg-card border border-border rounded-xl px-3 py-3 flex items-start gap-3 transition-all', nativeControls ? 'cursor-default' : 'hover:border-primary/40 active:scale-[0.99]')}>
                          <span className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${DOT_COLOR[task.priority]}`} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-foreground leading-snug">{task.title}</p>
                            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${PRIORITY_BADGE[task.priority]}`}>{t(PRIORITY_LABEL_KEY[task.priority])}</span>
                              {task.tag && <span className="text-xs text-muted-foreground flex items-center gap-1"><Tag className="w-3 h-3" />{task.tag}</span>}
                              <span className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" />{estimateLabel(task.estimateMinutes)}</span>
                            </div>
                          </div>
                          {!nativeControls && <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />}
                        </motion.button>
                      ))}
                    </div>
                  )}
                  {doneDayTasks.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">{t('view.completed')} — {doneDayTasks.length}</p>
                      {doneDayTasks.map((task, i) => (
                        <motion.button key={task.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04, duration: 0.2 }}
                          onClick={() => !nativeControls && setRepeatTask(task)}
                          className={cn('w-full text-left bg-muted/40 border border-border/60 rounded-xl px-3 py-3 flex items-start gap-3 transition-all group', nativeControls ? 'cursor-default' : 'hover:border-primary/30 hover:bg-muted/60 active:scale-[0.99]')}>
                          <CheckCircle2 className="mt-0.5 w-4 h-4 text-emerald-500 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-muted-foreground leading-snug line-through">{task.title}</p>
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              {task.tag && <span className="text-xs text-muted-foreground flex items-center gap-1"><Tag className="w-3 h-3" />{task.tag}</span>}
                              <span className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" />{estimateLabel(task.estimateMinutes)}</span>
                            </div>
                          </div>
                          {!nativeControls && (
                            <span className="text-xs text-primary font-semibold flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5">
                              <RotateCcw className="w-3.5 h-3.5" />{t('task.repeat')}
                            </span>
                          )}
                        </motion.button>
                      ))}
                    </div>
                  )}
                  {skippedDayTasks.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">{t('task.skipped')} — {skippedDayTasks.length}</p>
                      {skippedDayTasks.map((task, i) => (
                        <motion.button key={task.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04, duration: 0.2 }}
                          onClick={() => !nativeControls && setRepeatTask(task)}
                          className={cn('w-full text-left bg-muted/40 border border-border/60 rounded-xl px-3 py-3 flex items-start gap-3 transition-all group', nativeControls ? 'cursor-default' : 'hover:border-primary/30 hover:bg-muted/60 active:scale-[0.99]')}>
                          <SkipForward className="mt-0.5 w-4 h-4 text-muted-foreground flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-muted-foreground leading-snug">{task.title}</p>
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              {task.tag && <span className="text-xs text-muted-foreground flex items-center gap-1"><Tag className="w-3 h-3" />{task.tag}</span>}
                              <span className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" />{estimateLabel(task.estimateMinutes)}</span>
                            </div>
                          </div>
                          {!nativeControls && (
                            <span className="text-xs text-primary font-semibold flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5">
                              <RotateCcw className="w-3.5 h-3.5" />{t('task.repeat')}
                            </span>
                          )}
                        </motion.button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}

// --- Account Page ---

type FieldChoice = 'local' | 'cloud' | 'custom';

function ConflictResolutionPage({
  operations,
  tasks,
  onClose,
  onUseCloud,
  onResolveFieldConflict,
  onReapplyOrder,
  onCopyAsNewTask,
}: {
  operations: PendingOperation[];
  tasks: Task[];
  onClose: () => void;
  onUseCloud: (operation: PendingOperation) => void;
  onResolveFieldConflict: (operation: PendingOperation, payload: Record<string, unknown>) => void;
  onReapplyOrder: (operation: PendingOperation) => void;
  onCopyAsNewTask: (operation: PendingOperation) => void;
}) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = React.useState<string | null>(operations[0]?.operationId ?? null);
  const selected = operations.find(operation => operation.operationId === selectedId) ?? operations[0] ?? null;
  const serverTask = selected?.serverTask ?? null;
  const payload = payloadObject(selected?.clientPayload ?? selected?.payload);
  const payloadFields = Object.keys(payload).filter(isMergeField);
  const fields = (selected?.conflictType === 'delete-edit' && selected.conflictedFields?.length === 0
    ? payloadFields
    : selected?.conflictedFields ?? payloadFields) as MergeField[];
  const [choices, setChoices] = React.useState<Record<string, FieldChoice>>({});
  const [customValues, setCustomValues] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    if (!selected) return;
    const nextChoices: Record<string, FieldChoice> = {};
    for (const field of fields) nextChoices[field] = 'local';
    setChoices(nextChoices);
    setCustomValues({});
  }, [selected?.operationId]);

  const formatValue = (value: unknown): string => {
    if (value === null || value === undefined || value === '') return t('syncConflict.emptyValue');
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') {
      if (value === 'P1' || value === 'P2' || value === 'P3') return t(PRIORITY_LABEL_KEY[value as Priority]);
      if (value === 'todo') return t('view.toDo');
      if (value === 'done') return t('view.completed');
      if (value === 'skipped') return t('task.skipped');
      return value;
    }
    return JSON.stringify(value);
  };

  const buildResolvedPayload = (overrideChoice?: FieldChoice): Record<string, unknown> => {
    const next: Record<string, unknown> = {};
    for (const field of fields) {
      const choice = overrideChoice ?? choices[field] ?? 'local';
      if (choice === 'cloud') next[field] = taskFieldValue(serverTask, field);
      else if (choice === 'custom') next[field] = customValues[field] ?? '';
      else next[field] = payload[field];
    }
    if (selected?.conflictType === 'delete-edit') next.deletedAt = null;
    return next;
  };

  const conflictTitle = (operation: PendingOperation): string => {
    if (operation.conflictType === 'order') return t('syncConflict.orderTitle');
    if (operation.conflictType === 'delete-edit') return t('syncConflict.deleteEditTitle');
    const taskTitle = operation.serverTask?.title
      ?? (operation.taskId ? tasks.find(task => task.id === operation.taskId)?.title : null)
      ?? t('syncConflict.unknownTask');
    return taskTitle;
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] flex flex-col bg-background"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
        <button type="button" onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground hover:bg-muted">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 text-center">
          <h2 className="text-base font-bold">{t('syncConflict.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('syncConflict.subtitle', { count: operations.length })}</p>
        </div>
        <div className="h-10 w-10" />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[320px_minmax(0,1fr)]">
        <div className="border-b border-border p-4 md:border-b-0 md:border-r">
          <div className="space-y-2">
            {operations.map(operation => (
              <button
                key={operation.operationId}
                type="button"
                onClick={() => setSelectedId(operation.operationId)}
                className={cn(
                  'w-full rounded-xl border px-3 py-3 text-left transition-colors',
                  selected?.operationId === operation.operationId ? 'border-primary/40 bg-primary/10' : 'border-border bg-card hover:bg-muted/50'
                )}
              >
                <p className="truncate text-sm font-semibold text-foreground">{conflictTitle(operation)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {operation.conflictType === 'order'
                    ? t('syncConflict.orderConflict')
                    : t('syncConflict.fieldCount', { count: operation.conflictedFields?.length || 1 })}
                </p>
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 overflow-y-auto px-4 py-4">
          {!selected ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t('syncConflict.none')}</div>
          ) : selected.conflictType === 'order' ? (
            <div className="mx-auto max-w-xl space-y-4">
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                <h3 className="font-semibold text-foreground">{t('syncConflict.orderTitle')}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{t('syncConflict.orderDesc')}</p>
              </div>
              <button type="button" onClick={() => onUseCloud(selected)} className="w-full rounded-lg border border-border bg-card px-4 py-3 text-sm font-semibold">
                {t('syncConflict.useCloudOrder')}
              </button>
              <button type="button" onClick={() => onReapplyOrder(selected)} className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground">
                {t('syncConflict.reapplyLocalOrder')}
              </button>
            </div>
          ) : selected.conflictType === 'permanent-delete' ? (
            <div className="mx-auto max-w-xl space-y-4">
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                <h3 className="font-semibold text-foreground">{t('syncConflict.permanentDeleteTitle')}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{t('syncConflict.permanentDeleteDesc')}</p>
              </div>
              <button type="button" onClick={() => onUseCloud(selected)} className="w-full rounded-lg border border-border bg-card px-4 py-3 text-sm font-semibold">
                {t('syncConflict.discardLocal')}
              </button>
              <button type="button" onClick={() => onCopyAsNewTask(selected)} className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground">
                {t('syncConflict.copyAsNew')}
              </button>
            </div>
          ) : (
            <div className="mx-auto max-w-2xl space-y-4 pb-24">
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                <h3 className="font-semibold text-foreground">{selected.conflictType === 'delete-edit' ? t('syncConflict.deleteEditTitle') : t('syncConflict.fieldTitle')}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{t('syncConflict.fieldDesc')}</p>
              </div>

              {fields.map(field => {
                const localValue = payload[field];
                const cloudValue = taskFieldValue(serverTask, field);
                const canCustom = field === 'title' || field === 'tag';
                return (
                  <div key={field} className="rounded-xl border border-border bg-card px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-foreground">{t(FIELD_LABEL_KEY[field])}</p>
                      <div className="flex rounded-lg bg-muted p-1 text-xs font-semibold">
                        {(['local', 'cloud'] as FieldChoice[]).map(choice => (
                          <button
                            key={choice}
                            type="button"
                            onClick={() => setChoices(current => ({ ...current, [field]: choice }))}
                            className={cn('rounded-md px-2 py-1', (choices[field] ?? 'local') === choice ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground')}
                          >
                            {choice === 'local' ? t('syncConflict.local') : t('syncConflict.cloud')}
                          </button>
                        ))}
                        {canCustom && (
                          <button
                            type="button"
                            onClick={() => setChoices(current => ({ ...current, [field]: 'custom' }))}
                            className={cn('rounded-md px-2 py-1', choices[field] === 'custom' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground')}
                          >
                            {t('syncConflict.custom')}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <div className="rounded-lg bg-muted/70 px-3 py-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t('syncConflict.local')}</p>
                        <p className="mt-1 break-words text-sm text-foreground">{formatValue(localValue)}</p>
                      </div>
                      <div className="rounded-lg bg-muted/70 px-3 py-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t('syncConflict.cloud')}</p>
                        <p className="mt-1 break-words text-sm text-foreground">{formatValue(cloudValue)}</p>
                      </div>
                    </div>
                    {canCustom && choices[field] === 'custom' && (
                      <input
                        value={customValues[field] ?? ''}
                        onChange={(event) => setCustomValues(current => ({ ...current, [field]: event.target.value }))}
                        placeholder={formatValue(localValue)}
                        className="mt-3 h-11 w-full rounded-lg border border-input bg-input-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                      />
                    )}
                  </div>
                );
              })}

              <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-background/95 px-4 py-3 backdrop-blur md:left-[320px]">
                <div className="mx-auto grid max-w-2xl grid-cols-3 gap-2">
                  <button type="button" onClick={() => onUseCloud(selected)} className="rounded-lg border border-border px-3 py-3 text-xs font-semibold">
                    {t('syncConflict.allCloud')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onResolveFieldConflict(selected, buildResolvedPayload('local'))}
                    className="rounded-lg border border-border px-3 py-3 text-xs font-semibold"
                  >
                    {t('syncConflict.allLocal')}
                  </button>
                  <button type="button" onClick={() => onResolveFieldConflict(selected, buildResolvedPayload())} className="rounded-lg bg-primary px-3 py-3 text-xs font-semibold text-primary-foreground">
                    {t('syncConflict.saveMerge')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function AccountPage({ email, emailVerified, notificationPermission, accentTheme, onAccentThemeChange, onClose, onLogout, isLoggingOut, onOpenDeletedTasks, deletedCount, onDeleteAccount, onRetrySync, onOpenPrivacy, onRequestNotifications, onOpenConflicts, syncStatus, lastSync, pendingSyncCount, conflictCount }: {
  email: string;
  emailVerified: boolean;
  notificationPermission: NotificationPermissionState;
  accentTheme: AccentTheme;
  onAccentThemeChange: (theme: AccentTheme) => void;
  onClose: () => void;
  onLogout: () => void;
  isLoggingOut: boolean;
  onOpenDeletedTasks: () => void;
  deletedCount: number;
  onDeleteAccount: () => void;
  onRetrySync: () => void;
  onOpenPrivacy: () => void;
  onRequestNotifications: () => void;
  onOpenConflicts: () => void;
  syncStatus: SyncStatus;
  lastSync: string;
  pendingSyncCount: number;
  conflictCount: number;
}) {
  const { t, i18n } = useTranslation();
  const displayName = email.split('@')[0];
  const lastSyncLabel = lastSync ? new Date(lastSync).toLocaleString(i18n.language === 'zh' ? 'zh-CN' : 'en-US') : t('account.neverSynced');
  const syncNeedsAttention = syncStatus === 'conflict' || syncStatus === 'error';
  const syncSummaryLabel = syncStatus === 'idle'
    ? t('account.syncHealthy')
    : syncNeedsAttention
      ? t('account.syncNeedsAttention')
      : t('account.syncNotComplete');
  const syncBadgeClass = syncNeedsAttention
    ? 'bg-destructive/10 text-destructive'
    : syncStatus === 'syncing' || syncStatus === 'pending'
      ? 'bg-amber-500/10 text-amber-700'
      : 'bg-emerald-500/10 text-emerald-600';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-50 bg-background flex flex-col items-center overflow-hidden"
    >
      {/* Close button */}
      <button
        onClick={onClose}
        aria-label="Close account settings"
        className="absolute top-0 left-4 w-9 h-9 flex items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
        style={{ top: 'max(1.5rem, env(safe-area-inset-top))' }}
      >
        <X className="w-5 h-5" />
      </button>

      {/* Content */}
      <div className="flex-1 w-full overflow-y-auto px-6 pt-safe pb-6">
      <div className="mx-auto flex w-full max-w-md flex-col pt-16">
        <div className="flex items-center gap-4 rounded-2xl border border-border bg-card px-4 py-4">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-muted">
            <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='1.5'%3E%3Cpath d='M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'/%3E%3Ccircle cx='12' cy='7' r='4'/%3E%3C/svg%3E"
              alt="Avatar" className="h-9 w-9 opacity-50" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('account.overview')}</p>
            <h2 className="mt-1 truncate text-xl font-bold text-foreground">{displayName}</h2>
            <p className="truncate text-sm text-muted-foreground">{email}</p>
            <span className={cn('mt-2 inline-flex rounded-full px-2.5 py-1 text-xs font-semibold', emailVerified ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600')}>
              {emailVerified ? t('account.emailVerified') : t('account.emailUnverified')}
            </span>
          </div>
        </div>

        <div className="mt-5 w-full space-y-5">
          {/* Accent color */}
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('account.preferences')}</p>
            <p className="text-sm font-semibold text-foreground">{t('account.accentColor')}</p>
            <div className="grid grid-cols-5 gap-2">
              {(Object.keys(ACCENT_THEME_PRESETS) as AccentTheme[]).map((theme) => (
                <button
                  key={theme}
                  type="button"
                  onClick={() => onAccentThemeChange(theme)}
                  className={cn(
                    'h-10 rounded-xl border transition-all',
                    accentTheme === theme ? 'border-foreground/40 shadow-sm scale-[1.02]' : 'border-border'
                  )}
                  style={{ backgroundColor: ACCENT_THEME_PRESETS[theme].primary }}
                  aria-label={t(`account.accent.${theme}`)}
                  title={t(`account.accent.${theme}`)}
                />
              ))}
            </div>
          </div>

          {/* Language */}
          <div className="space-y-2">
            <p className="text-sm font-semibold text-foreground">{t('account.language')}</p>
            <div className="flex bg-muted rounded-xl p-1">
              <button
                onClick={() => { i18n.changeLanguage('zh'); try { localStorage.setItem('taskflow_lang', 'zh'); } catch { /**/ } }}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-semibold rounded-lg transition-all ${
                  i18n.language === 'zh' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Globe className="w-4 h-4 flex-shrink-0" />{t('account.chinese')}
              </button>
              <button
                onClick={() => { i18n.changeLanguage('en'); try { localStorage.setItem('taskflow_lang', 'en'); } catch { /**/ } }}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-semibold rounded-lg transition-all ${
                  i18n.language !== 'zh' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Globe className="w-4 h-4 flex-shrink-0" />{t('account.english')}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('account.sync')}</p>
            <div className="rounded-xl border border-border bg-card px-4 py-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold text-foreground">{syncSummaryLabel}</span>
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', syncBadgeClass)}>
                  {t(`sync.${syncStatus}`)}
                </span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t(`syncDetails.${syncStatus}`)}</p>
              <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>{t('account.pendingSync')}</span>
                <span>{pendingSyncCount}</span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>{t('syncConflict.countLabel')}</span>
                <span>{conflictCount}</span>
              </div>
              <div className="mt-1 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>{t('account.lastSync')}</span>
                <span className="text-right">{lastSyncLabel}</span>
              </div>
              {conflictCount > 0 && (
                <button
                  type="button"
                  onClick={onOpenConflicts}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-500/15"
                >
                  {t('syncConflict.open')}
                </button>
              )}
              <button
                type="button"
                onClick={onRetrySync}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
              >
                <RotateCw className={cn('h-3.5 w-3.5', syncStatus === 'syncing' && 'animate-spin')} />
                {t('account.retrySync')}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('account.data')}</p>
            <button
              type="button"
              onClick={onOpenDeletedTasks}
              className="flex w-full items-center justify-between rounded-xl border border-border bg-card px-4 py-3 text-left text-sm font-semibold text-foreground transition-colors hover:bg-muted/50"
            >
              <span>{t('task.recentlyDeleted')}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{deletedCount}</span>
            </button>
            <button
              type="button"
              onClick={onOpenPrivacy}
              className="flex w-full items-center justify-between rounded-xl border border-border bg-card px-4 py-3 text-left text-sm font-semibold text-foreground transition-colors hover:bg-muted/50"
            >
              <span>{t('account.privacyPolicy')}</span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('account.reminders')}</p>
            <div className="rounded-xl border border-border bg-card px-4 py-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold text-foreground">{t('account.notificationPermission')}</span>
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', notificationPermission === 'granted' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600')}>
                  {t(`notifications.permission.${notificationPermission}`)}
                </span>
              </div>
              {notificationPermission !== 'unsupported' && notificationPermission !== 'granted' && (
                <button
                  type="button"
                  onClick={onRequestNotifications}
                  className="mt-3 flex w-full items-center justify-center rounded-lg bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
                >
                  {t('account.enableNotifications')}
                </button>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('account.security')}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{t('account.localCacheNote')}</p>
            <button
              type="button"
              onClick={onDeleteAccount}
              className="flex w-full items-center justify-between rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-left text-sm font-semibold text-destructive transition-colors hover:bg-destructive/10"
            >
              <span>{t('account.deleteAccount')}</span>
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onLogout}
              disabled={isLoggingOut}
              className="flex w-full items-center justify-center rounded-xl bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/20 active:scale-95 disabled:cursor-wait disabled:opacity-70"
            >
              {isLoggingOut ? t('account.signingOut') : t('account.signOut')}
            </button>
          </div>
        </div>
      </div>
      </div>
    </motion.div>
  );
}

function DeletedTasksDialog({ open, tasks, loading, onClose, onRestore, onPermanentDelete }: {
  open: boolean;
  tasks: Task[];
  loading: boolean;
  onClose: () => void;
  onRestore: (task: Task) => void;
  onPermanentDelete: (task: Task) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] backdrop-blur-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-[50%] top-[50%] z-[61] flex max-h-[78vh] w-[calc(100%-2rem)] max-w-md translate-x-[-50%] translate-y-[-50%] flex-col rounded-3xl border border-border bg-card p-5 shadow-2xl focus:outline-none">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-lg font-bold">{t('task.recentlyDeleted')}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted-foreground">
                {t('task.recentlyDeletedDesc')}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button aria-label="Close recently deleted" className="rounded-full bg-muted p-2 text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              </div>
            ) : tasks.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border p-8 text-center">
                <p className="text-sm font-semibold text-foreground">{t('task.noDeletedTasks')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('task.noDeletedTasksDesc')}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {tasks.map(task => (
                  <div key={task.id} className="rounded-2xl border border-border bg-background/50 p-3">
                    <div className="flex items-start gap-3">
                      <span className={`mt-1.5 h-2.5 w-2.5 rounded-full ${DOT_COLOR[task.priority]}`} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-foreground">{task.title}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span>{estimateLabel(task.estimateMinutes)}</span>
                          <span>{task.priority}</span>
                          {task.deletedAt && <span>{new Date(task.deletedAt).toLocaleDateString()}</span>}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => onRestore(task)}
                        className="rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground active:scale-95"
                      >
                        {t('task.restore')}
                      </button>
                      <button
                        type="button"
                        onClick={() => onPermanentDelete(task)}
                        className="rounded-xl bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive active:scale-95"
                      >
                        {t('task.deleteForever')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PrivacyPolicyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const items = t('privacy.items', { returnObjects: true }) as string[];
  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] backdrop-blur-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-[50%] top-[50%] z-[61] max-h-[78vh] w-[calc(100%-2rem)] max-w-md translate-x-[-50%] translate-y-[-50%] overflow-y-auto rounded-3xl border border-border bg-card p-5 shadow-2xl focus:outline-none">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-lg font-bold">{t('privacy.title')}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted-foreground">{t('privacy.description')}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="rounded-full bg-muted p-2 text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>
          <div className="space-y-3">
            {items.map((item, index) => (
              <p key={index} className="rounded-xl bg-muted/50 px-4 py-3 text-sm leading-relaxed text-muted-foreground">{item}</p>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// --- Main App ---

// AppShell contains all hooks — must never be rendered conditionally to satisfy Rules of Hooks
function AppShell({
  user,
  accentTheme,
  onAccentThemeChange,
  onLogout,
  onAccountDeleted,
  isLoggingOut,
  cloudSyncEnabled,
}: {
  user: AuthUser;
  accentTheme: AccentTheme;
  onAccentThemeChange: (theme: AccentTheme) => void;
  onLogout: () => void;
  onAccountDeleted: () => void;
  isLoggingOut: boolean;
  cloudSyncEnabled: boolean;
}) {
  const { t, i18n } = useTranslation();
  const shouldReduceMotion = useReducedMotion() ?? false;
  const isNativeShell = Capacitor.isNativePlatform();
  const [tasks, setTasks] = useState<Task[]>(() => loadTasks(user.id));
  const [streak, setStreak] = useState(() => loadStatsFromCache(user.id).streak);
  const [completedToday, setCompletedToday] = useState(() => loadStatsFromCache(user.id).completedToday);
  const [syncMeta, setSyncMeta] = useState(() => loadSyncMeta(user.id));
  const [pendingOperations, setPendingOperations] = useState<PendingOperation[]>(() => loadPendingOperations(user.id));
  const tasksRef = React.useRef(tasks);
  const pendingOperationsRef = React.useRef(pendingOperations);
  const syncMetaRef = React.useRef(syncMeta);
  const completedTodayRef = React.useRef(completedToday);
  completedTodayRef.current = completedToday;
  pendingOperationsRef.current = pendingOperations;
  syncMetaRef.current = syncMeta;
  const hasInteractedRef = React.useRef(false);
  const actionLocksRef = React.useRef(new Set<string>());
  const syncInFlightRef = React.useRef(false);
  const syncRequestedRef = React.useRef(false);
  const syncNoticeKeyRef = React.useRef('');
  const scheduledNotificationIdsRef = React.useRef(new Set<number>());
  const [tasksLoading, setTasksLoading] = useState(true);
  const [exitAction, setExitAction] = useState<TaskActionState | null>(null);
  const [actingTaskIds, setActingTaskIds] = useState<Set<string>>(() => new Set());
  const [viewMode, setViewMode] = useState<ViewMode>('flow');
  const greeting = useMemo(() => getGreeting(t), [t]);
  const [isReordering, setIsReordering] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [flowDetailTaskId, setFlowDetailTaskId] = useState<string | null>(null);
  const [manageTaskId, setManageTaskId] = useState<string | null>(null);

  const [isAddingTask, setIsAddingTask] = useState(false);
  const [isTaskDetailsOpen, setIsTaskDetailsOpen] = useState(false);
  const [showQuickReminder, setShowQuickReminder] = useState(false);
  const [isRepeatMode, setIsRepeatMode] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionState>('unsupported');
  const [form, setForm] = useState<AddTaskState>(() => defaultAddTaskForm());
  const [formErrors, setFormErrors] = useState<AddTaskErrors>({});
  const [deletedTasksOpen, setDeletedTasksOpen] = useState(false);
  const [deletedTasks, setDeletedTasks] = useState<Task[]>([]);
  const [deletedTasksLoading, setDeletedTasksLoading] = useState(false);
  const repeatPreviewCount = useMemo(
    () => repeatInstanceCount(form.dueDate, form.repeatUntilDate, form.repeatRule),
    [form.dueDate, form.repeatRule, form.repeatUntilDate]
  );

  const refreshNotificationPermission = React.useCallback(async (request = false) => {
    const permission = await getNotificationPermission(request);
    setNotificationPermission(permission);
    if (request && permission !== 'granted' && permission !== 'unsupported') {
      toast.error(t('notifications.permissionDenied'));
    }
    return permission;
  }, [t]);

  const toTask = React.useCallback((t: TaskDTO): Task => ({
    id: t.id,
    title: t.title,
    priority: t.priority as Priority,
    estimateMinutes: t.estimateMinutes,
    status: t.status as TaskStatus,
    tag: t.tag ?? undefined,
    dueDate: t.dueDate,
    reminderAt: t.reminderAt,
    repeatRule: (t.repeatRule as Task['repeatRule']) ?? 'none',
    repeatUntilDate: t.repeatUntilDate,
    completedAt: t.completedAt,
    deletedAt: t.deletedAt,
    sortOrder: t.sortOrder,
    version: t.version,
    lastChangedByDeviceId: t.lastChangedByDeviceId,
    updatedAt: t.updatedAt,
    _dirty: false,
    _syncState: undefined,
    _operationId: undefined,
    _conflict: false,
    _syncError: false,
  }), []);

  const setTasksAndCache = React.useCallback((updater: React.SetStateAction<Task[]>) => {
    setTasks(prev => {
      const next = typeof updater === 'function' ? (updater as (prev: Task[]) => Task[])(prev) : updater;
      tasksRef.current = next;
      saveTasksToCache(user.id, next);
      return next;
    });
  }, [user.id]);

  const setSyncMetaAndCache = React.useCallback((updater: React.SetStateAction<SyncMeta>) => {
    setSyncMeta(prev => {
      const next = typeof updater === 'function' ? (updater as (prev: SyncMeta) => SyncMeta)(prev) : updater;
      syncMetaRef.current = next;
      saveSyncMeta(user.id, next);
      return next;
    });
  }, [user.id]);

  const setPendingOperationsAndCache = React.useCallback((updater: React.SetStateAction<PendingOperation[]>) => {
    setPendingOperations(prev => {
      const next = typeof updater === 'function' ? (updater as (prev: PendingOperation[]) => PendingOperation[])(prev) : updater;
      pendingOperationsRef.current = next;
      savePendingOperations(user.id, next);
      return next;
    });
  }, [user.id]);

  const queueOperation = React.useCallback((operation: PendingSyncOperationDTO) => {
    const baseTask = operation.taskId ? tasksRef.current.find(task => task.id === operation.taskId) : null;
    const pending: PendingOperation = {
      ...operation,
      baseTaskSnapshot: baseTask ? taskPatch(baseTask) : undefined,
      createdAt: new Date().toISOString(),
      retryCount: 0,
      status: 'pending',
    };
    setPendingOperationsAndCache(prev => [...prev.filter(item => item.operationId !== pending.operationId), pending]);
    return pending.operationId;
  }, [setPendingOperationsAndCache]);

  const updateSyncStatusFromTasks = React.useCallback((nextTasks: Task[]) => {
    if (!cloudSyncEnabled) {
      setSyncStatus('idle');
      return;
    }
    if (nextTasks.some(task => task._conflict)) {
      setSyncStatus('conflict');
      return;
    }
    if (nextTasks.some(task => task._syncError)) {
      setSyncStatus('error');
      return;
    }
    const hasPending = pendingOperationsRef.current.some(operation => operation.status === 'pending');
    setSyncStatus(hasPending ? (navigator.onLine ? 'pending' : 'offline') : 'idle');
  }, [cloudSyncEnabled]);

  useEffect(() => {
    refreshNotificationPermission(false);
  }, [refreshNotificationPermission]);

  useEffect(() => {
    let cancelled = false;
    async function syncReminderNotifications() {
      if (notificationPermission !== 'granted') return;
      const candidates = tasks.filter(canNotifyTask);
      const nextIds = new Set(candidates.map(task => notificationIdForTask(task.id)));
      const cancelIds = new Set([...scheduledNotificationIdsRef.current, ...nextIds]);
      if (cancelIds.size > 0) {
        await LocalNotifications.cancel({
          notifications: [...cancelIds].map(id => ({ id })),
        }).catch(() => undefined);
      }
      if (cancelled || candidates.length === 0) {
        scheduledNotificationIdsRef.current = new Set();
        return;
      }
      await LocalNotifications.schedule({
        notifications: candidates.map(task => {
          const copy = notificationCopy(task, t, i18n.language);
          return {
            id: notificationIdForTask(task.id),
            title: copy.title,
            body: copy.body,
            schedule: { at: new Date(task.reminderAt!) },
            extra: { taskId: task.id },
          };
        }),
      }).catch(() => undefined);
      if (!cancelled) scheduledNotificationIdsRef.current = nextIds;
    }
    syncReminderNotifications();
    return () => { cancelled = true; };
  }, [i18n.language, notificationPermission, tasks, t]);

  // On mount: pull all tasks from cloud (cloud-primary), fall back to cache
  useEffect(() => {
    let cancelled = false;
    async function init() {
      if (!cloudSyncEnabled) {
        const cached = loadTasks(user.id);
        setTasksAndCache(cached.length > 0 ? cached : []);
        setTasksLoading(false);
        setSyncStatus('idle');
        return;
      }
      let serverReachable = false;
      try {
        const remote = await apiSyncBootstrap();
        if (!cancelled) {
          serverReachable = true;
          const remoteTasks = remote.tasks.map(toTask);
          setTasksAndCache(remoteTasks);
          setDeletedTasks(remote.deletedTasks.map(toTask));
          setSyncMetaAndCache({
            syncCursor: remote.currentCursor,
            lastSuccessfulSyncAt: remote.serverTime,
            taskOrderVersion: remote.taskOrderVersion,
          });
          if (remote.userStats) {
            saveStatsToCache(user.id, remote.userStats.streak, remote.userStats.todayCount, remote.userStats.streakDate);
            if (!hasInteractedRef.current) {
              setStreak(remote.userStats.streak);
              setCompletedToday(remote.userStats.todayCount);
            }
          }
          const syncedAt = new Date().toISOString();
          setSyncMetaAndCache(current => ({ ...current, lastSuccessfulSyncAt: syncedAt }));
        }
      } catch {
        console.warn('TaskFlow: server unreachable, using cached data');
      }

      if (cancelled) return;

      // If offline, use cached tasks
      if (!serverReachable) {
        const cached = loadTasks(user.id);
        setTasksAndCache(cached.length > 0 ? cached : []);
      }

      // Stats — cache gives instant offline feedback; server recomputes authoritative values.
      try {
        const cached = loadStatsFromCache(user.id);
        if (!cancelled && !hasInteractedRef.current) {
          setStreak(cached.streak);
          setCompletedToday(cached.completedToday);
        }

        // Background: sync with server (only populate cache, don't overwrite state)
        if (serverReachable) {
          apiGetUserStats().then(stats => {
            if (!hasInteractedRef.current && cached.streak === 0) {
              // First-ever login — sync initial streak from server
              setStreak(stats.streak);
              setCompletedToday(stats.todayCount);
            }
            saveStatsToCache(user.id, stats.streak, stats.todayCount, stats.streakDate);
          }).catch(() => {});
        }
      } catch {
        // Non-critical — cache already loaded above
      }
      if (!cancelled) setTasksLoading(false);
    }
    init();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudSyncEnabled, setSyncMetaAndCache, setTasksAndCache, toTask, user.id]);

  // On native cold-start, restore data from Capacitor Preferences if localStorage was cleared
  useEffect(() => {
    const STORAGE_KEYS = [
      userStorageKey(user.id, 'tasks'),
      userStorageKey(user.id, 'streak'),
      userStorageKey(user.id, 'completed_today'),
    ];
    restoreFromNativeStorage(STORAGE_KEYS).then(() => {
      // Re-read from localStorage into state; if API already loaded, don't overwrite
      setTasksAndCache(prev => prev.length === 0 ? loadTasks(user.id) : prev);
      const cached = loadStatsFromCache(user.id);
      setStreak(prev => prev === 0 ? cached.streak : prev);
      setCompletedToday(prev => prev === 0 ? cached.completedToday : prev);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

  useEffect(() => {
    if (!isAddingTask && !isTaskDetailsOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeTaskForm(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAddingTask, isTaskDetailsOpen]);

  // Cache tasks to localStorage whenever they change
  useEffect(() => { saveTasksToCache(user.id, tasks); }, [tasks, user.id]);
  useEffect(() => {
    if (!cloudSyncEnabled) {
      setSyncStatus('idle');
      return;
    }
    if (pendingOperations.some(operation => operation.status === 'conflict')) setSyncStatus('conflict');
    else if (pendingOperations.some(operation => operation.status === 'failed')) setSyncStatus('error');
    else if (pendingOperations.some(operation => operation.status === 'pending')) setSyncStatus(navigator.onLine ? 'pending' : 'offline');
    else setSyncStatus('idle');
  }, [cloudSyncEnabled, pendingOperations]);

  useEffect(() => {
    if (syncStatus !== 'syncing') return;
    const timer = window.setTimeout(() => {
      if (syncInFlightRef.current) return;
      const current = pendingOperationsRef.current;
      if (current.some(operation => operation.status === 'conflict')) setSyncStatus('conflict');
      else if (current.some(operation => operation.status === 'failed')) setSyncStatus('error');
      else if (current.some(operation => operation.status === 'pending')) setSyncStatus(navigator.onLine ? 'pending' : 'offline');
      else setSyncStatus('idle');
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [syncStatus]);

  const applyRemoteChange = React.useCallback((currentTasks: Task[], change: SyncChangeDTO): Task[] => {
    if (change.type === 'reorder' && change.snapshot && 'order' in change.snapshot && Array.isArray(change.snapshot.order)) {
      const orderMap = new Map(change.snapshot.order.map(item => [item.id, item.sortOrder]));
      return currentTasks.map(task => orderMap.has(task.id) ? { ...task, sortOrder: orderMap.get(task.id)! } : task);
    }
    if (change.type === 'permanent-delete') {
      const taskId = change.taskId || change.tombstone?.taskId;
      return taskId ? currentTasks.filter(task => task.id !== taskId) : currentTasks;
    }
    if (!change.snapshot || !('id' in change.snapshot)) return currentTasks;
    const remoteTask = toTask(change.snapshot as TaskDTO);
    const existingIndex = currentTasks.findIndex(task => task.id === remoteTask.id);
    if (existingIndex < 0) return [...currentTasks, remoteTask];
    return currentTasks.map(task => task.id === remoteTask.id ? { ...task, ...remoteTask } : task);
  }, [toTask]);

  const runSync = React.useCallback(async () => {
    if (!cloudSyncEnabled) {
      setSyncStatus('idle');
      return;
    }
    if (syncInFlightRef.current) {
      syncRequestedRef.current = true;
      return;
    }
    if (!navigator.onLine) {
      setSyncStatus(pendingOperationsRef.current.some(operation => operation.status === 'pending') ? 'offline' : 'idle');
      return;
    }
    syncInFlightRef.current = true;
    syncRequestedRef.current = false;
    setSyncStatus('syncing');
    let attemptedOperationIds = new Set<string>();
    try {
      const pending = pendingOperationsRef.current.filter(operation => operation.status === 'pending');
      const readyPending = pending.filter(isOperationReady);
      if (pending.length > 0 && readyPending.length === 0) {
        console.warn('TaskFlow sync queue has pending operations waiting on unresolved local ids', pending);
        setSyncStatus('error');
        return;
      }
      if (readyPending.length > 0) {
        attemptedOperationIds = new Set(readyPending.map(operation => operation.operationId));
        const response = await apiPushOperations(getDeviceId(user.id), readyPending);
        const acceptedIds = new Set(response.accepted.map(item => item.operationId));
        const conflictById = new Map(response.conflicts.map(item => [item.operationId, item]));
        const rejectedIds = new Set(response.rejected.map(item => item.operationId).filter((id): id is string => !!id));
        const idReplacements = new Map<string, string>();
        let autoMergedConflict = false;

        for (const accepted of response.accepted) {
          if (accepted.task) {
            const savedTask = toTask(accepted.task);
            if (accepted.clientTaskId && accepted.clientTaskId !== savedTask.id) {
              idReplacements.set(accepted.clientTaskId, savedTask.id);
            }
            setTasksAndCache(current => current.map(task =>
              task.id === savedTask.id || (accepted.clientTaskId && task.id === accepted.clientTaskId)
                ? { ...task, ...savedTask, _dirty: false, _syncState: undefined, _operationId: undefined, _conflict: false }
                : task
            ));
          }
          if (accepted.order) {
            setSyncMetaAndCache(current => ({ ...current, taskOrderVersion: accepted.order!.taskOrderVersion }));
          }
          if (accepted.tombstone && typeof accepted.tombstone === 'object' && 'taskId' in accepted.tombstone) {
            const taskId = String((accepted.tombstone as { taskId?: unknown }).taskId);
            setTasksAndCache(current => current.filter(task => task.id !== taskId));
          }
        }

        setPendingOperationsAndCache(current => current
          .filter(operation => !acceptedIds.has(operation.operationId))
          .map(operation => idReplacements.size > 0 ? remapOperationIds(operation, idReplacements) : operation)
          .map(operation => {
            const conflict = conflictById.get(operation.operationId);
            if (!conflict) return operation;
            const clientOperation = conflict.clientOperation ?? operation;
            const conflictType = conflictTypeFor(conflict.code, clientOperation, conflict.serverTask);
            const conflictedFields = conflictFieldsFor(operation, conflict.serverTask);
            if (conflictType === 'field' && conflict.serverTask && conflictedFields.length === 0) {
              autoMergedConflict = true;
              return {
                ...operation,
                type: 'resolve-conflict',
                baseVersion: conflict.serverVersion ?? conflict.serverTask.version,
                payload: clientOperation.payload ?? operation.payload,
                retryCount: 0,
                status: 'pending' as const,
                conflictType: undefined,
                serverTask: undefined,
                serverVersion: undefined,
                clientPayload: undefined,
                conflictedFields: undefined,
                detectedAt: undefined,
              };
            }
            return {
              ...operation,
              status: 'conflict' as const,
              conflictType,
              serverTask: conflict.serverTask,
              serverVersion: conflict.serverVersion ?? conflict.serverTask?.version,
              serverOrderVersion: conflict.serverOrderVersion,
              clientPayload: clientOperation.payload ?? operation.payload,
              conflictedFields,
              detectedAt: new Date().toISOString(),
            };
          })
          .map(operation => rejectedIds.has(operation.operationId)
              ? { ...operation, status: 'failed' as const }
              : operation));

        if (idReplacements.size > 0 && pendingOperationsRef.current.some(operation => operation.status === 'pending')) {
          syncRequestedRef.current = true;
        }
        if (autoMergedConflict) {
          syncRequestedRef.current = true;
        }
      }

      let cursor = syncMetaRef.current.syncCursor;
      let hasMore = true;
      let pullPages = 0;
      let lastServerTime = new Date().toISOString();
      while (hasMore) {
        pullPages += 1;
        if (pullPages > 20) throw new Error('Sync pull pagination did not converge');
        const pulled = await apiPullChanges(cursor);
        if (pulled.changes.length > 0) {
          setTasksAndCache(current => pulled.changes.reduce((next, change) => applyRemoteChange(next, change), current));
        }
        if (pulled.nextCursor === cursor && pulled.hasMore) throw new Error('Sync cursor did not advance');
        cursor = pulled.nextCursor;
        hasMore = pulled.hasMore;
        lastServerTime = pulled.serverTime;
      }
      setSyncMetaAndCache(current => ({ ...current, syncCursor: cursor, lastSuccessfulSyncAt: lastServerTime }));
      const nextPending = pendingOperationsRef.current;
      const hasConflict = nextPending.some(operation => operation.status === 'conflict');
      const hasFailed = nextPending.some(operation => operation.status === 'failed');
      const hasPending = nextPending.some(operation => operation.status === 'pending');
      setSyncStatus(hasConflict ? 'conflict' : hasFailed ? 'error' : hasPending ? 'pending' : 'idle');
    } catch (error) {
      console.error('TaskFlow sync failed', {
        error,
        attemptedOperationIds: Array.from(attemptedOperationIds),
        pendingOperations: pendingOperationsRef.current,
      });
      setSyncStatus(navigator.onLine ? 'error' : 'offline');
      if (attemptedOperationIds.size > 0) {
        setPendingOperationsAndCache(current => current.map(operation =>
          attemptedOperationIds.has(operation.operationId)
            ? { ...operation, retryCount: operation.retryCount + 1 }
            : operation
        ));
      }
      void error;
    } finally {
      syncInFlightRef.current = false;
      if (syncRequestedRef.current) {
        syncRequestedRef.current = false;
        window.setTimeout(() => void runSync(), 0);
      }
    }
  }, [applyRemoteChange, cloudSyncEnabled, setPendingOperationsAndCache, setSyncMetaAndCache, setTasksAndCache, toTask, user.id]);

  const retryDirtyTasks = runSync;
  const retryAllSyncOperations = React.useCallback(() => {
    const failedOperations = pendingOperationsRef.current.filter(operation => operation.status === 'failed');
    if (failedOperations.length > 0) {
      const next = pendingOperationsRef.current.map(operation =>
        operation.status === 'failed'
          ? { ...operation, status: 'pending' as const, retryCount: 0 }
          : operation
      );
      pendingOperationsRef.current = next;
      savePendingOperations(user.id, next);
      setPendingOperations(next);
    }
    void runSync();
  }, [runSync, user.id]);

  useEffect(() => {
    retryDirtyTasks();
    const handleOnline = () => retryDirtyTasks();
    const handleOffline = () => {
      if (!cloudSyncEnabled) {
        setSyncStatus('idle');
        return;
      }
      if (pendingOperationsRef.current.some(operation => operation.status === 'pending')) setSyncStatus('offline');
      else setSyncStatus('idle');
    };
    const handleFocus = () => retryDirtyTasks();
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('focus', handleFocus);
    };
  }, [cloudSyncEnabled, retryDirtyTasks, user.id]);

  const activeTasks = useMemo(() => tasks.filter(t => !t.deletedAt), [tasks]);
  const pendingTasks = useMemo(() => activeTasks.filter(t => t.status === 'todo'), [activeTasks]);
  const pendingSyncCount = useMemo(() => pendingOperations.length, [pendingOperations]);
  const conflictOperations = useMemo(() => pendingOperations.filter(operation => operation.status === 'conflict'), [pendingOperations]);
  const effectiveSyncStatus = useMemo(
    () => visibleSyncStatus(syncStatus, pendingOperations, syncMeta, cloudSyncEnabled),
    [cloudSyncEnabled, pendingOperations, syncMeta, syncStatus]
  );
  const syncRequiresUserAction = effectiveSyncStatus === 'conflict';
  const flowDetailTask = flowDetailTaskId ? activeTasks.find(t => t.id === flowDetailTaskId) ?? null : null;
  const manageTask = manageTaskId ? activeTasks.find(t => t.id === manageTaskId) ?? null : null;

  useEffect(() => {
    const shouldNotify = effectiveSyncStatus === 'error' || effectiveSyncStatus === 'offline' || effectiveSyncStatus === 'conflict';
    if (!shouldNotify) {
      if (effectiveSyncStatus === 'idle') syncNoticeKeyRef.current = '';
      return;
    }
    const noticeKey = `${effectiveSyncStatus}:${pendingSyncCount}:${conflictOperations.length}`;
    if (syncNoticeKeyRef.current === noticeKey) return;
    syncNoticeKeyRef.current = noticeKey;
    toast(t(`sync.${effectiveSyncStatus}`), {
      description: t(`syncDetails.${effectiveSyncStatus}`),
      duration: effectiveSyncStatus === 'conflict' ? 6000 : 3500,
      action: effectiveSyncStatus === 'conflict'
        ? { label: t('syncConflict.open'), onClick: () => setConflictsOpen(true) }
        : undefined,
    });
  }, [conflictOperations.length, effectiveSyncStatus, pendingSyncCount, t]);

  useEffect(() => {
    if (conflictsOpen && conflictOperations.length === 0) setConflictsOpen(false);
  }, [conflictOperations.length, conflictsOpen]);

  const removeConflictOperation = React.useCallback((operationId: string) => {
    setPendingOperationsAndCache(prev => prev.filter(operation => operation.operationId !== operationId));
  }, [setPendingOperationsAndCache]);

  const handleUseCloudConflict = React.useCallback((operation: PendingOperation) => {
    if (operation.conflictType === 'permanent-delete' && operation.taskId) {
      setTasksAndCache(prev => prev.filter(task => task.id !== operation.taskId));
      removeConflictOperation(operation.operationId);
      return;
    }
    if (operation.serverTask) {
      const cloudTask = toTask(operation.serverTask);
      setTasksAndCache(prev => {
        const exists = prev.some(task => task.id === cloudTask.id);
        return exists
          ? prev.map(task => task.id === cloudTask.id ? cloudTask : task)
          : [...prev, cloudTask];
      });
    }
    if (operation.conflictType === 'order' && operation.serverOrderVersion) {
      setSyncMetaAndCache(current => ({ ...current, taskOrderVersion: operation.serverOrderVersion! }));
    }
    removeConflictOperation(operation.operationId);
  }, [removeConflictOperation, setSyncMetaAndCache, setTasksAndCache, toTask]);

  const handleResolveFieldConflict = React.useCallback((operation: PendingOperation, payload: Record<string, unknown>) => {
    if (!operation.taskId) return;
    const nextOperation: PendingOperation = {
      operationId: syncOperationId(),
      type: 'resolve-conflict',
      taskId: operation.taskId,
      baseVersion: operation.serverVersion ?? operation.serverTask?.version ?? null,
      payload,
      createdAt: new Date().toISOString(),
      retryCount: 0,
      status: 'pending',
    };
    setPendingOperationsAndCache(prev => [...prev.filter(item => item.operationId !== operation.operationId), nextOperation]);
    setTasksAndCache(prev => prev.map(task => task.id === operation.taskId ? {
      ...task,
      ...payload,
      _dirty: true,
      _syncState: 'update',
      _operationId: nextOperation.operationId,
      _conflict: false,
      _syncError: false,
    } as Task : task));
    if (cloudSyncEnabled) window.setTimeout(() => void retryDirtyTasks(), 0);
  }, [cloudSyncEnabled, retryDirtyTasks, setPendingOperationsAndCache, setTasksAndCache]);

  const handleReapplyOrderConflict = React.useCallback((operation: PendingOperation) => {
    const nextOperation: PendingOperation = {
      ...operation,
      operationId: syncOperationId(),
      baseOrderVersion: operation.serverOrderVersion ?? syncMetaRef.current.taskOrderVersion,
      createdAt: new Date().toISOString(),
      retryCount: 0,
      status: 'pending',
      conflictType: undefined,
      serverOrderVersion: undefined,
      detectedAt: undefined,
    };
    setPendingOperationsAndCache(prev => [...prev.filter(item => item.operationId !== operation.operationId), nextOperation]);
    if (cloudSyncEnabled) window.setTimeout(() => void retryDirtyTasks(), 0);
  }, [cloudSyncEnabled, retryDirtyTasks, setPendingOperationsAndCache]);

  const handleCopyConflictAsNewTask = React.useCallback((operation: PendingOperation) => {
    const sourceTask = operation.taskId ? tasksRef.current.find(task => task.id === operation.taskId) : null;
    const tempId = localTaskId();
    const payload = sourceTask ? taskPatch({ ...sourceTask, id: tempId, deletedAt: null }) : payloadObject(operation.clientPayload ?? operation.payload);
    const newTask: Task = {
      id: tempId,
      title: String(payload.title || 'Recovered task'),
      priority: (payload.priority === 'P1' || payload.priority === 'P2' || payload.priority === 'P3') ? payload.priority : 'P2',
      estimateMinutes: typeof payload.estimateMinutes === 'number' ? payload.estimateMinutes : null,
      status: (typeof payload.status === 'string' && STATUSES_FOR_CLIENT.has(payload.status)) ? payload.status as TaskStatus : 'todo',
      tag: typeof payload.tag === 'string' ? payload.tag : null,
      dueDate: typeof payload.dueDate === 'string' ? payload.dueDate : quickDueDate(0),
      reminderAt: typeof payload.reminderAt === 'string' ? payload.reminderAt : null,
      repeatRule: (payload.repeatRule === 'daily' || payload.repeatRule === 'weekly' || payload.repeatRule === 'monthly') ? payload.repeatRule : 'none',
      repeatUntilDate: typeof payload.repeatUntilDate === 'string' ? payload.repeatUntilDate : null,
      deletedAt: null,
      completedAt: null,
      sortOrder: tasksRef.current.filter(task => task.status === 'todo' && !task.deletedAt).length,
      version: 1,
      updatedAt: new Date().toISOString(),
      _dirty: true,
      _syncState: 'create',
      _operationId: syncOperationId(),
      _conflict: false,
    };
    setTasksAndCache(prev => [...prev, newTask]);
    setPendingOperationsAndCache(prev => [
      ...prev.filter(item => item.operationId !== operation.operationId),
      {
        operationId: newTask._operationId || syncOperationId(),
        type: 'create',
        clientTaskId: newTask.id,
        payload: taskPatch(newTask),
        createdAt: new Date().toISOString(),
        retryCount: 0,
        status: 'pending' as const,
      },
    ]);
    if (cloudSyncEnabled) window.setTimeout(() => void retryDirtyTasks(), 0);
  }, [cloudSyncEnabled, retryDirtyTasks, setPendingOperationsAndCache, setTasksAndCache]);

  const applyPendingOrder = React.useCallback((orderedIds: string[]) => {
    const idRank = new Map(orderedIds.map((id, index) => [id, index]));

    setTasksAndCache(prev => {
      const pending = prev.filter(task => task.status === 'todo' && !task.deletedAt);
      const pendingById = new Map(pending.map(task => [task.id, task]));
      const orderedPending = orderedIds
        .map(id => pendingById.get(id))
        .filter((task): task is Task => !!task);
      const newlyAddedPending = pending.filter(task => !idRank.has(task.id));
      const nonPending = prev.filter(task => task.status !== 'todo' || task.deletedAt);
      let sortOrder = 0;
      const nextPending = [...orderedPending, ...newlyAddedPending].map(task => markOrderDirty(task, sortOrder++));
      const next = [...nextPending, ...nonPending];
      updateSyncStatusFromTasks(next);
      return next;
    });
    queueOperation({
      operationId: syncOperationId(),
      type: 'reorder',
      baseOrderVersion: syncMetaRef.current.taskOrderVersion,
      payload: { order: orderedIds.map((id, index) => ({ id, sortOrder: index })) },
    });

    if (cloudSyncEnabled) window.setTimeout(() => void retryDirtyTasks(), 0);
  }, [cloudSyncEnabled, queueOperation, retryDirtyTasks, setTasksAndCache, updateSyncStatusFromTasks]);

  const handleAction = (id: string, action: ExitAction) => {
    if (actionLocksRef.current.has(id)) return;
    actionLocksRef.current.add(id);
    Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {});
    setExitAction({ taskId: id, action });
    setActingTaskIds(prev => new Set(prev).add(id));
    const unlock = () => {
      actionLocksRef.current.delete(id);
      setActingTaskIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    };

    hasInteractedRef.current = true;
    if (action === 'snooze') {
      setTimeout(() => {
        const latestTasks = tasksRef.current;
        const task = latestTasks.find(t => t.id === id);
        if (!task) {
          unlock();
          return;
        }
        const previousPendingIds = latestTasks
          .filter(t => t.status === 'todo' && !t.deletedAt)
          .map(t => t.id);
        let undoRequested = false;
        const reordered = [...latestTasks.filter(t => t.id !== id), task];
        const nextPendingIds = reordered
          .filter(t => t.status === 'todo' && !t.deletedAt)
          .map(t => t.id);
        let sortOrder = 0;
        const normalized = reordered.map(t => {
          if (t.status !== 'todo' || t.deletedAt) return t;
          return markOrderDirty(t, sortOrder++);
        });
        setTasksAndCache(prev => {
          if (!task) return prev;
          if (prev !== latestTasks) {
            const nextTask = prev.find(t => t.id === id);
            if (!nextTask) return prev;
            let nextSortOrder = 0;
            return [...prev.filter(t => t.id !== id), nextTask].map(t => {
              if (t.status !== 'todo' || t.deletedAt) return t;
              return markOrderDirty(t, nextSortOrder++);
            });
          }
          return normalized;
        });
        window.setTimeout(() => {
          setExitAction(current => current?.taskId === id && current.action === action ? null : current);
        }, 520);
        toast(t('task.snoozeMoved'), {
          description: t('task.snoozeMovedDesc'),
          action: {
            label: t('task.undo'),
            onClick: () => {
              undoRequested = true;
              applyPendingOrder(previousPendingIds);
            },
          },
        });
        window.setTimeout(() => {
          unlock();
          if (undoRequested) applyPendingOrder(previousPendingIds);
          else if (!cloudSyncEnabled) applyPendingOrder(nextPendingIds);
          else void retryDirtyTasks();
        }, 520);
      }, 170);
    } else {
      const newStatus = action === 'complete' ? 'done' : 'skipped';
      setTimeout(() => {
        const task = tasksRef.current.find(t => t.id === id);
        const shouldCreateLegacyRepeat = action === 'complete' && task && task.repeatRule && task.repeatRule !== 'none' && !task.repeatUntilDate;
        const legacyRepeatDueDate = shouldCreateLegacyRepeat ? nextRepeatDate(task.dueDate, task.repeatRule) : null;
        const legacyRepeatTask = task && legacyRepeatDueDate
          ? buildRepeatedTasks(task, [legacyRepeatDueDate], tasksRef.current.filter(t => t.status === 'todo' && !t.deletedAt).length)[0]
          : null;
        const operationId = syncOperationId();
        queueOperation({
          operationId,
          type: 'update',
          taskId: id,
          baseVersion: task?.version ?? 1,
          payload: { status: newStatus },
        });
        if (legacyRepeatTask) {
          queueOperation({
            operationId: legacyRepeatTask._operationId || syncOperationId(),
            type: 'create',
            clientTaskId: legacyRepeatTask.id,
            payload: taskPatch(legacyRepeatTask),
          });
        }

        setTasksAndCache(prev => {
          const updated = prev.map(t => t.id !== id ? t : { ...t, status: newStatus as TaskStatus });
          return markDirty(legacyRepeatTask ? [...updated, legacyRepeatTask] : updated, id, 'update', operationId);
        });
        window.setTimeout(() => {
          if (cloudSyncEnabled) void retryDirtyTasks();
          unlock();
        }, 0);
        if (action === 'complete') {
          const newCount = completedTodayRef.current + 1;
          setCompletedToday(newCount);

          // Compute streak locally: if first completion today, check continuity
          let newStreak = streak; // default: same as current
          if (completedTodayRef.current === 0) {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yStr = yesterday.toISOString().split('T')[0];
            try {
              const raw = storageGet(userStorageKey(user.id, 'streak'));
              if (raw) {
                const { count, lastDate } = JSON.parse(raw) as { count: number; lastDate: string };
                newStreak = lastDate === yStr ? count + 1 : 1;
              } else {
                newStreak = 1;
              }
            } catch { newStreak = 1; }
            setStreak(newStreak);
            saveStatsToCache(user.id, newStreak, newCount);
          } else {
            saveStatsToCache(user.id, streak, newCount);
          }

          // Ask the server to recompute stats from completed tasks.
          if (cloudSyncEnabled) void retryDirtyTasks();
        }
        window.setTimeout(() => {
          setExitAction(current => current?.taskId === id && current.action === action ? null : current);
        }, 520);
      }, 170);
    }
  };

  /** Apply reordered pending tasks back into the full tasks array */
  const handleSaveOrder = (newPendingOrder: Task[]) => {
    setTasksAndCache(prev => {
      const nonPending = prev.filter(t => t.status !== 'todo');
      return [...newPendingOrder.map((task, index) => markOrderDirty(task, index)), ...nonPending];
    });
    queueOperation({
      operationId: syncOperationId(),
      type: 'reorder',
      baseOrderVersion: syncMetaRef.current.taskOrderVersion,
      payload: { order: newPendingOrder.map((task, index) => ({ id: task.id, sortOrder: index })) },
    });
    if (cloudSyncEnabled) window.setTimeout(() => void retryDirtyTasks(), 0);
  };

  const persistTaskUpdate = (id: string, data: Partial<Task>, operationId?: string): Promise<boolean> => {
    const task = tasksRef.current.find(item => item.id === id);
    queueOperation({
      operationId: operationId || syncOperationId(),
      type: 'update',
      taskId: id,
      baseVersion: task?.version ?? 1,
      payload: data,
    });
    if (cloudSyncEnabled) window.setTimeout(() => void retryDirtyTasks(), 0);
    return Promise.resolve(true);
  };

  const resetTaskForm = () => {
    setIsRepeatMode(false);
    setEditingTaskId(null);
    setShowQuickReminder(false);
    setForm(defaultAddTaskForm());
    setFormErrors({});
  };

  const closeQuickCreate = () => {
    setIsAddingTask(false);
    resetTaskForm();
  };

  const closeTaskDetails = () => {
    setIsTaskDetailsOpen(false);
    resetTaskForm();
  };

  const closeTaskForm = () => {
    setIsAddingTask(false);
    setIsTaskDetailsOpen(false);
    resetTaskForm();
  };

  const openEditTask = (task: Task) => {
    setForm({
      title: task.title,
      minutes: task.estimateMinutes ? String(task.estimateMinutes) : '',
      priority: task.priority,
      dueDate: task.dueDate || '',
      reminderAt: task.reminderAt || '',
      repeatRule: task.repeatRule || 'none',
      repeatUntilDate: task.repeatUntilDate || '',
      tag: task.tag || '',
    });
    setEditingTaskId(task.id);
    setIsRepeatMode(false);
    setFormErrors({});
    setIsTaskDetailsOpen(true);
  };

  const updateTaskForm = (patch: Partial<AddTaskState>) => {
    setForm(current => ({ ...current, ...patch }));
    setFormErrors(current => {
      const next = { ...current };
      Object.keys(patch).forEach(key => { delete next[key as keyof AddTaskErrors]; });
      return next;
    });
  };

  const updateReminder = (value: string) => {
    updateTaskForm({ reminderAt: value });
    if (value && notificationPermission !== 'granted' && notificationPermission !== 'unsupported') {
      void refreshNotificationPermission(true);
    }
  };

  const refreshDeletedTasks = React.useCallback(async () => {
    setDeletedTasksLoading(true);
    try {
      if (cloudSyncEnabled) {
        const remote = await apiSyncBootstrap();
        setDeletedTasks(remote.deletedTasks.map(toTask));
      } else {
        setDeletedTasks(loadTasks(user.id).filter(task => !!task.deletedAt));
      }
    } catch {
      setDeletedTasks(loadTasks(user.id).filter(task => !!task.deletedAt));
      toast.error(t('task.deletedLoadFailed'));
    } finally {
      setDeletedTasksLoading(false);
    }
  }, [cloudSyncEnabled, t, toTask, user.id]);

  const openDeletedTasks = React.useCallback(() => {
    setDeletedTasksOpen(true);
    refreshDeletedTasks();
  }, [refreshDeletedTasks]);

  const handleRestoreDeletedTask = React.useCallback((task: Task) => {
    const operationId = syncOperationId();
    queueOperation({
      operationId,
      type: 'restore',
      taskId: task.id,
      baseVersion: task.version ?? 1,
    });
    setDeletedTasks(prev => prev.filter(t => t.id !== task.id));
    setTasksAndCache(prev => {
      const restored = { ...task, deletedAt: null, _dirty: true, _syncState: 'update' as const, _operationId: operationId, _conflict: false };
      const exists = prev.some(t => t.id === task.id);
      return exists
        ? prev.map(t => t.id === task.id ? { ...t, deletedAt: null, _dirty: restored._dirty, _syncState: restored._syncState, _operationId: operationId } : t)
        : [...prev, restored];
    });
    if (cloudSyncEnabled) window.setTimeout(() => void retryDirtyTasks(), 0);
  }, [cloudSyncEnabled, queueOperation, retryDirtyTasks, setTasksAndCache]);

  const handlePermanentDeleteTask = React.useCallback((task: Task) => {
    const confirmed = window.confirm(t('task.deleteForeverConfirm'));
    if (!confirmed) return;
    setDeletedTasks(prev => prev.filter(t => t.id !== task.id));
    if (task.id.startsWith('local-')) {
      setPendingOperationsAndCache(prev => prev
        .map(operation => removeTaskFromOperation(operation, task.id))
        .filter((operation): operation is PendingOperation => !!operation));
      setTasksAndCache(prev => prev.filter(t => t.id !== task.id));
      return;
    }
    const operationId = syncOperationId();
    queueOperation({
      operationId,
      type: 'permanent-delete',
      taskId: task.id,
      baseVersion: task.version ?? 1,
    });
    setTasksAndCache(prev => prev.map(item => item.id === task.id ? {
      ...item,
      _dirty: true,
      _syncState: 'permanent-delete',
      _operationId: operationId,
      _conflict: false,
    } : item));
    if (cloudSyncEnabled) window.setTimeout(() => void retryDirtyTasks(), 0);
  }, [cloudSyncEnabled, queueOperation, retryDirtyTasks, setPendingOperationsAndCache, setTasksAndCache, t]);

  const handleDeleteAccount = React.useCallback(async () => {
    const confirmed = window.confirm(t('account.deleteAccountConfirm'));
    if (!confirmed) return;
    try {
      await apiDeleteAccount();
      clearUserLocalCache(user.id);
      onAccountDeleted();
      toast.success(t('account.deleteAccountSuccess'));
    } catch {
      toast.error(t('account.deleteAccountFailed'));
    }
  }, [onAccountDeleted, t, user.id]);

  const handleDeleteTask = (task: Task) => {
    const deletedAt = new Date().toISOString();
    const operationId = syncOperationId();
    queueOperation({
      operationId,
      type: 'soft-delete',
      taskId: task.id,
      baseVersion: task.version ?? 1,
    });
    setTasksAndCache(prev => markDirty(prev.map(t => t.id === task.id ? { ...t, deletedAt } : t), task.id, 'update', operationId));
    toast(t('task.deleted'), {
      description: t('task.deletedDesc'),
      action: {
        label: t('task.undo'),
        onClick: () => {
          const undoOperationId = syncOperationId();
          queueOperation({
            operationId: undoOperationId,
            type: 'restore',
            taskId: task.id,
            baseVersion: (tasksRef.current.find(item => item.id === task.id)?.version ?? task.version) ?? 1,
          });
          setTasksAndCache(prev => markDirty(prev.map(t => t.id === task.id ? { ...t, deletedAt: null } : t), task.id, 'update', undoOperationId));
          if (cloudSyncEnabled) window.setTimeout(() => void retryDirtyTasks(), 0);
        },
      },
    });
    if (cloudSyncEnabled) window.setTimeout(() => void retryDirtyTasks(), 0);
  };

  const handleRepeatTask = (task: Task) => {
    setForm({
      title: task.title,
      minutes: task.estimateMinutes ? String(task.estimateMinutes) : '',
      priority: task.priority,
      dueDate: quickDueDate(0),
      reminderAt: '',
      repeatRule: task.repeatRule || 'none',
      repeatUntilDate: task.repeatUntilDate || '',
      tag: task.tag || '',
    });
    setIsRepeatMode(true);
    setEditingTaskId(null);
    setFormErrors({});
    setIsTaskDetailsOpen(true);
  };

  const openAddTask = () => {
    setForm(defaultAddTaskForm());
    setFormErrors({});
    setIsRepeatMode(false);
    setEditingTaskId(null);
    setShowQuickReminder(false);
    setIsAddingTask(true);
  };

  const openDraftDetails = () => {
    setIsAddingTask(false);
    setIsTaskDetailsOpen(true);
  };

  const validateTaskForm = (candidate: AddTaskState): AddTaskErrors => {
    const errors: AddTaskErrors = {};
    if (!candidate.title.trim()) errors.title = t('task.errors.titleRequired');
    if (!candidate.dueDate) errors.dueDate = t('task.errors.dueDateRequired');
    const minutes = candidate.minutes.trim() ? Number.parseInt(candidate.minutes, 10) : null;
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) {
      errors.minutes = t('task.errors.minutesRange');
    }
    if (candidate.reminderAt) {
      const reminderTime = new Date(candidate.reminderAt).getTime();
      if (Number.isNaN(reminderTime)) {
        errors.reminderAt = t('task.errors.reminderInvalid');
      } else if (reminderTime <= Date.now()) {
        errors.reminderAt = t('task.errors.reminderPast');
      }
    }
    if (candidate.repeatRule !== 'none') {
      if (!candidate.repeatUntilDate) {
        errors.repeatUntilDate = t('task.errors.repeatUntilRequired');
      } else if (candidate.dueDate && candidate.repeatUntilDate <= candidate.dueDate) {
        errors.repeatUntilDate = t('task.errors.repeatUntilAfterDue');
      }
    }
    return errors;
  };

  const createTaskFromForm = (candidate: AddTaskState): string => {
    const tempId = localTaskId();
    const clientKey = syncOperationId();
    const repeatUntilDate = candidate.repeatRule === 'none' ? null : candidate.repeatUntilDate;
    const estimateMinutes = candidate.minutes.trim() ? Number.parseInt(candidate.minutes, 10) : null;
    const currentTasks = tasksRef.current;
    const idx = insertIndex(currentTasks, { id: tempId, title: '', priority: candidate.priority, estimateMinutes: null, status: 'todo', dueDate: candidate.dueDate, sortOrder: 0 } as Task);
    const optimisticTask: Task = {
      id: tempId,
      _clientKey: clientKey,
      _dirty: true,
      _syncState: 'create',
      _operationId: syncOperationId(),
      title: candidate.title.trim(),
      priority: candidate.priority,
      estimateMinutes,
      status: 'todo',
      dueDate: candidate.dueDate,
      reminderAt: candidate.reminderAt || null,
      repeatRule: candidate.repeatRule,
      repeatUntilDate,
      deletedAt: null,
      tag: candidate.tag || null,
      sortOrder: idx,
      version: 1,
      updatedAt: new Date().toISOString(),
    };
    const repeatedTasks = repeatUntilDate
      ? buildRepeatedTasks(optimisticTask, repeatDatesAfterStart(candidate.dueDate, repeatUntilDate, candidate.repeatRule), idx + 1)
      : [];
    setTasksAndCache(previous => {
      const next = [optimisticTask, ...repeatedTasks].reduce((ordered, task) => {
        const insertAt = insertIndex(ordered, task);
        return [...ordered.slice(0, insertAt), task, ...ordered.slice(insertAt)];
      }, previous);
      updateSyncStatusFromTasks(next);
      return next;
    });
    queueOperation({
      operationId: optimisticTask._operationId || syncOperationId(),
      type: 'create',
      clientTaskId: optimisticTask.id,
      payload: taskPatch(optimisticTask),
    });
    for (const repeatedTask of repeatedTasks) {
      queueOperation({
        operationId: repeatedTask._operationId || syncOperationId(),
        type: 'create',
        clientTaskId: repeatedTask.id,
        payload: taskPatch(repeatedTask),
      });
    }
    if (cloudSyncEnabled) window.setTimeout(() => retryDirtyTasks(), 0);
    return clientKey;
  };

  const handleQuickCreate = (event: React.FormEvent) => {
    event.preventDefault();
    const quickForm = { ...form, repeatRule: 'none' as const, repeatUntilDate: '', minutes: '', tag: '' };
    const errors = validateTaskForm(quickForm);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const clientKey = createTaskFromForm(quickForm);
    setViewMode('flow');
    closeQuickCreate();
    toast(t('task.created'), {
      description: t('task.createdDesc'),
      action: {
        label: t('task.completeDetails'),
        onClick: () => {
          const createdTask = tasksRef.current.find(task => task._clientKey === clientKey);
          if (createdTask) openEditTask(createdTask);
        },
      },
    });
  };

  const handleAddTask = async (e: React.FormEvent) => {
    e.preventDefault();
    const errors = validateTaskForm(form);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;
    if (repeatPreviewCount > 30 && !window.confirm(t('task.repeatLargeConfirm', { count: repeatPreviewCount }))) {
      return;
    }
    if (editingTaskId) {
      const existingTask = tasksRef.current.find(task => task.id === editingTaskId);
      const patch: Partial<Task> = {
        title: form.title.trim(),
        priority: form.priority,
        estimateMinutes: form.minutes.trim() ? Number.parseInt(form.minutes, 10) : null,
        dueDate: form.dueDate || null,
        reminderAt: form.reminderAt || null,
        repeatRule: form.repeatRule,
        repeatUntilDate: form.repeatRule === 'none' ? null : form.repeatUntilDate,
        tag: form.tag || null,
      };
      const editedTask: Task | null = existingTask ? { ...existingTask, ...patch } : null;
      const repeatedTasks = editedTask && patch.repeatUntilDate
        ? buildRepeatedTasks(
          editedTask,
          repeatDatesAfterStart(form.dueDate, patch.repeatUntilDate, form.repeatRule).filter(dueDate =>
            !tasksRef.current.some(task =>
              task.id !== editingTaskId
              && !task.deletedAt
              && task.dueDate === dueDate
              && task.title === editedTask.title
              && task.repeatRule === editedTask.repeatRule
            )
          ),
          tasksRef.current.filter(t => t.status === 'todo' && !t.deletedAt).length
        )
        : [];
      const operationId = syncOperationId();
      setTasksAndCache(prev => {
        const updated = prev.map(t => t.id === editingTaskId ? { ...t, ...patch } : t);
        return markDirty([...updated, ...repeatedTasks], editingTaskId, 'update', operationId);
      });
      for (const repeatedTask of repeatedTasks) {
        queueOperation({
          operationId: repeatedTask._operationId || syncOperationId(),
          type: 'create',
          clientTaskId: repeatedTask.id,
          payload: taskPatch(repeatedTask),
        });
      }
      persistTaskUpdate(editingTaskId, patch, operationId).then((canFlushRepeatedTasks) => {
        if (canFlushRepeatedTasks && repeatedTasks.length > 0) void retryDirtyTasks();
      });
      closeTaskDetails();
      return;
    }
    createTaskFromForm(form);
    closeTaskDetails();
  };

  return (
    <MotionConfig reducedMotion="user">
    <div className="app-viewport app-safe-y bg-background text-foreground flex flex-col items-center overscroll-none selection:bg-primary/20">
      <TaskDetailModal
        task={flowDetailTask}
        onClose={() => setFlowDetailTaskId(null)}
        onAction={handleAction}
        actionDisabled={flowDetailTask ? actingTaskIds.has(flowDetailTask.id) : false}
        onManage={(task) => setManageTaskId(task.id)}
      />

      <TaskManageDialog
        task={manageTask}
        onClose={() => setManageTaskId(null)}
        onEdit={openEditTask}
        onDelete={handleDeleteTask}
      />

      <DeletedTasksDialog
        open={deletedTasksOpen}
        tasks={deletedTasks}
        loading={deletedTasksLoading}
        onClose={() => setDeletedTasksOpen(false)}
        onRestore={handleRestoreDeletedTask}
        onPermanentDelete={handlePermanentDeleteTask}
      />

      {/* Account Page */}
      <AnimatePresence>
        {accountOpen && (
          <AccountPage
            email={user.email}
            emailVerified={!!(user.emailVerifiedAt || user.emailVerified)}
            notificationPermission={notificationPermission}
            accentTheme={accentTheme}
            onAccentThemeChange={onAccentThemeChange}
            onClose={() => setAccountOpen(false)}
            onLogout={onLogout}
            isLoggingOut={isLoggingOut}
            onOpenDeletedTasks={() => {
              openDeletedTasks();
            }}
            deletedCount={tasks.filter(task => !!task.deletedAt).length || deletedTasks.length}
            onDeleteAccount={handleDeleteAccount}
            onRetrySync={retryAllSyncOperations}
            onOpenPrivacy={() => setPrivacyOpen(true)}
            onRequestNotifications={() => refreshNotificationPermission(true)}
            onOpenConflicts={() => setConflictsOpen(true)}
            syncStatus={effectiveSyncStatus}
            lastSync={syncMeta.lastSuccessfulSyncAt}
            pendingSyncCount={pendingSyncCount}
            conflictCount={conflictOperations.length}
          />
        )}
      </AnimatePresence>

      <PrivacyPolicyDialog
        open={privacyOpen}
        onClose={() => setPrivacyOpen(false)}
      />

      <AnimatePresence>
        {conflictsOpen && (
          <ConflictResolutionPage
            operations={conflictOperations}
            tasks={tasks}
            onClose={() => setConflictsOpen(false)}
            onUseCloud={handleUseCloudConflict}
            onResolveFieldConflict={handleResolveFieldConflict}
            onReapplyOrder={handleReapplyOrderConflict}
            onCopyAsNewTask={handleCopyConflictAsNewTask}
          />
        )}
      </AnimatePresence>

      <header className="w-full max-w-md px-4 sm:px-6 flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-semibold tracking-normal">{greeting}</h1>
            <p className="text-muted-foreground text-sm flex items-center gap-1.5 mt-1">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              <span>{t('task.tasksDoneToday', { count: completedToday })}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 bg-card border border-border px-3 py-1.5 rounded-full shadow-sm">
              <Flame className="w-4 h-4 text-orange-500" fill="currentColor" />
              <span className="text-sm font-semibold">{t('stats.streakDays', { count: streak })}</span>
            </div>
            <button
              onClick={() => setAccountOpen(true)}
              title="Account"
              aria-label="Open account settings"
              className="w-9 h-9 flex items-center justify-center rounded-full bg-muted hover:bg-muted/80 transition-colors overflow-hidden"
            >
              <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2'%3E%3Cpath d='M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'/%3E%3Ccircle cx='12' cy='7' r='4'/%3E%3C/svg%3E"
                alt="User" className="w-5 h-5 opacity-60" />
            </button>
          </div>
      </header>

      {syncRequiresUserAction && (
        <div
          className="w-full max-w-md px-4 sm:px-6 mb-3"
          role="alert"
          aria-live="polite"
        >
          <button
            onClick={() => setConflictsOpen(true)}
            className="w-full flex flex-col items-center justify-center gap-1 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive"
          >
            <span className="flex items-center gap-2">
              <RotateCw className="w-3.5 h-3.5" />
              {t(`sync.${effectiveSyncStatus}`)}
            </span>
            <span className="font-normal opacity-80">{t(`syncDetails.${effectiveSyncStatus}`)}</span>
          </button>
        </div>
      )}

      {/* Toast notifications */}
      <Toaster
        position="top-center"
        closeButton
        offset={{ top: isNativeShell ? 'calc(env(safe-area-inset-top) + 28px)' : '10px' }}
        mobileOffset={{
          top: isNativeShell ? 'calc(env(safe-area-inset-top) + 28px)' : '10px',
          left: '16px',
          right: '16px',
        }}
        style={{ '--width': '360px' } as React.CSSProperties}
        toastOptions={{
          style: {
            minHeight: '42px',
            padding: '10px 14px',
            borderRadius: '24px',
            border: '1px solid var(--border)',
            background: 'var(--card)',
            color: 'var(--foreground)',
            boxShadow: '0 12px 30px rgba(15, 23, 42, 0.12)',
          },
        }}
      />

      <div className="w-full max-w-md px-4 sm:px-6 flex justify-center mb-5">
          <ViewToggle view={viewMode} onChange={setViewMode} />
      </div>

      {/* Loading state */}
      {tasksLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>
      {/*
       * Sliding container: both views rendered side-by-side, container translates
       * to reveal the active panel. Eliminates AnimatePresence exit/enter timing
       * issues and produces perfectly smooth transitions in both directions.
       */}
      <div className="w-full max-w-md overflow-x-hidden flex-1 overflow-hidden relative">
        <motion.div
          className="flex items-stretch h-full"
          style={{ width: '200%', willChange: 'transform' }}
          animate={{ x: viewMode === 'flow' ? '0%' : '-50%' }}
          initial={false}
          transition={shouldReduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 360, damping: 36, mass: 0.85 }}
        >
          {/* ── Flow panel ── */}
          <div className="h-full overflow-y-auto px-4 sm:px-6 pb-4" style={{ width: '50%' }}>
            {pendingTasks.length > 0 ? (
              <div className="mx-auto flex min-h-full w-full max-w-sm flex-col items-center gap-3">
                <div className={cn(
                  'relative h-[clamp(360px,54vh,470px)] w-full max-w-[360px] shrink-0',
                  'mt-[clamp(1.75rem,5vh,3.25rem)]'
                )}>
                  <AnimatePresence custom={exitAction} mode="popLayout">
                    {pendingTasks.slice(0, 3).map((task, index) => {
                      const isTop = index === 0;
                      return (
                        <motion.div
                          key={task.id}
                          layout
                          custom={exitAction}
                          initial={shouldReduceMotion ? false : { opacity: 0, y: 50, scale: 0.9 }}
                          animate={{
                            opacity: index > 1 ? 0 : 1 - index * 0.15,
                            y: index * 14,
                            scale: 1 - index * 0.035,
                            zIndex: 10 - index,
                          }}
                          exit={(custom: TaskActionState | null) => taskExitMotion(custom?.taskId === task.id ? custom.action : null, shouldReduceMotion)}
                          transition={shouldReduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 340, damping: 34, mass: 0.72 }}
                          className={`absolute inset-0 w-full h-full ${!isTop ? 'pointer-events-none' : ''}`}
                        >
                          <TaskCard
                            task={task}
                            onAction={handleAction}
                            pendingAction={exitAction?.taskId === task.id ? exitAction.action : null}
                            actionDisabled={actingTaskIds.has(task.id)}
                            onOpen={isTop ? () => setFlowDetailTaskId(task.id) : undefined}
                          />
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>

                {/* Up next + reorder button */}
                <div className="w-full px-1 py-1">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="min-w-0">
	                      <span className="block text-xs font-semibold uppercase text-muted-foreground">{t('task.upNext')}</span>
	                      <span className="block truncate text-[11px] text-muted-foreground">
	                        {t('task.queuedCount', { count: Math.max(pendingTasks.length - 1, 0) })}
	                      </span>
                    </div>
                    <button
	                      onClick={() => setIsReordering(true)}
	                      aria-label={t('task.reorderTasks')}
	                      className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                    >
                      <ArrowUpDown className="w-3.5 h-3.5" />{t('task.reorder')}
                    </button>
                  </div>
                  <div className="max-h-32 space-y-1 overflow-y-auto pr-1">
                    {pendingTasks.slice(1).map((task, index) => (
                      <div key={task.id} className="grid min-h-10 grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-1.5 text-muted-foreground hover:bg-muted/50">
                        <span className="w-5 text-right text-[11px] font-semibold text-muted-foreground tabular-nums">{index + 2}</span>
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${DOT_COLOR[task.priority]}`} />
                        <span className="min-w-0 truncate text-sm font-medium text-foreground/85">{task.title}</span>
                        {task.estimateMinutes ? <span className="text-xs">{estimateLabel(task.estimateMinutes)}</span> : <span />}
                      </div>
                    ))}
                    {pendingTasks.length === 1 && (
                      <p className="px-2 py-2 text-sm text-muted-foreground">{t('task.noMoreTasks')}</p>
                    )}
                  </div>
                </div>

                {/* Hint */}
                <div className="flex w-full flex-wrap gap-x-4 gap-y-1 px-1 pb-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><AlarmClock className="w-3 h-3" />{t('task.snoozeHint')}</span>
                  <span className="flex items-center gap-1"><SkipForward className="w-3 h-3" />{t('task.skipHint')}</span>
                </div>
              </div>
            ) : (
              <motion.div initial={shouldReduceMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                className="flex flex-col items-center justify-center h-full w-full max-w-sm text-center px-6">
                <div className="w-16 h-16 bg-muted text-muted-foreground rounded-2xl flex items-center justify-center mb-5">
                  <CheckCircle2 className="w-8 h-8" />
                </div>
                <h2 className="text-xl font-semibold mb-2">{activeTasks.length === 0 ? t('task.emptyNewTitle') : t('task.allCaughtUp')}</h2>
                <p className="text-sm text-muted-foreground mb-7">{activeTasks.length === 0 ? t('task.emptyNewDesc') : t('task.allCaughtUpDesc')}</p>
                <button onClick={openAddTask} className="w-full py-3 bg-primary text-primary-foreground font-semibold rounded-xl">{t('task.addNewTask')}</button>
              </motion.div>
            )}
          </div>

          {/* ── Calendar panel ── */}
          <div className="flex flex-col items-center px-4 sm:px-6 pb-4 h-full overflow-y-auto" style={{ width: '50%' }}>
            <CalendarView
              tasks={activeTasks}
              onAction={handleAction}
              onAddTask={openAddTask}
              onRepeatTask={handleRepeatTask}
              onManageTask={(task) => setManageTaskId(task.id)}
              actingTaskIds={actingTaskIds}
              showAddTaskPrompt
              nativeControls={false}
            />
          </div>
        </motion.div>
      </div>

      {/* Reorder Sheet */}
      <ReorderSheet
        isOpen={isReordering}
        pendingTasks={pendingTasks}
        onClose={() => setIsReordering(false)}
        onSave={handleSaveOrder}
      />
      </>
      )}

      <>
          <button
            onClick={openAddTask}
            aria-label={t('task.addTask')}
            className="fixed bottom-safe right-6 sm:right-8 w-12 h-12 bg-primary text-primary-foreground rounded-full flex items-center justify-center shadow-lg shadow-primary/20 hover:bg-primary/90 transition-transform active:scale-95 z-40"
          >
            <Plus className="w-6 h-6" />
          </button>

          <QuickCreateDialog
            open={isAddingTask}
            form={form}
            errors={formErrors}
            showReminder={showQuickReminder}
            onClose={closeQuickCreate}
            onSubmit={handleQuickCreate}
            onOpenDetails={openDraftDetails}
            onFormChange={updateTaskForm}
            onReminderChange={updateReminder}
            onShowReminderChange={setShowQuickReminder}
          />

          <TaskDetailsSheet
            open={isTaskDetailsOpen}
            form={form}
            errors={formErrors}
            repeatPreviewCount={repeatPreviewCount}
            editing={!!editingTaskId}
            repeatMode={isRepeatMode}
            onClose={closeTaskDetails}
            onSubmit={handleAddTask}
            onFormChange={updateTaskForm}
            onReminderChange={updateReminder}
          />
      </>
    </div>
    </MotionConfig>
  );
}

// App handles auth state only; AppShell holds all hooks (Rules of Hooks compliance)
export default function App() {
  const { t } = useTranslation();
  // 'loading' = checking refresh cookie, 'auth' = not logged in, 'app' = logged in
  const [appState, setAppState] = useState<'loading' | 'auth' | 'app'>('loading');
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(() => {
    const session = loadSession();
    return session && !session.signedOut && session.userId
      ? { id: session.userId, email: session.email, emailVerifiedAt: session.emailVerifiedAt ?? null }
      : null;
  });
  const [cloudSyncEnabled, setCloudSyncEnabled] = useState(false);
  const [accentTheme, setAccentTheme] = useState<AccentTheme>('tcx111400');
  const [accentThemeReady, setAccentThemeReady] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function initAccentTheme() {
      await restoreFromNativeStorage([ACCENT_THEME_KEY]);
      if (cancelled) return;
      setAccentTheme(loadAccentTheme());
      setAccentThemeReady(true);
    }
    initAccentTheme();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!accentThemeReady) return;
    applyAccentTheme(accentTheme);
    storageSet(ACCENT_THEME_KEY, accentTheme);
  }, [accentTheme, accentThemeReady]);

  // Keep a stable app viewport height across iOS toolbar/safe-area changes.
  useEffect(() => {
    const forceStableHeight = appState !== 'app';
    const updateViewportHeight = () => {
      syncAppViewportHeight(forceStableHeight);
    };

    updateViewportHeight();
    const viewport = window.visualViewport;
    window.addEventListener('resize', updateViewportHeight);
    window.addEventListener('orientationchange', updateViewportHeight);
    viewport?.addEventListener('resize', updateViewportHeight);
    viewport?.addEventListener('scroll', updateViewportHeight);

    return () => {
      window.removeEventListener('resize', updateViewportHeight);
      window.removeEventListener('orientationchange', updateViewportHeight);
      viewport?.removeEventListener('resize', updateViewportHeight);
      viewport?.removeEventListener('scroll', updateViewportHeight);
    };
  }, [appState]);

  // Re-sync viewport after auth/loading → app transition to avoid iOS keyboard carryover.
  useEffect(() => {
    if (appState !== 'app') return;
    const runForced = () => syncAppViewportHeight(true);
    const runDynamic = () => syncAppViewportHeight(false);
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    runForced();
    const t1 = window.setTimeout(runForced, 120);
    const t2 = window.setTimeout(runDynamic, 320);
    const t3 = window.setTimeout(runDynamic, 800);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, [appState]);

  // Register a global auth-failure callback so apiFetch can trigger logout
  useEffect(() => {
    setAuthFailureHandler(() => {
      const session = loadSession();
      if (session && !session.signedOut && !isSessionExpired(session)) {
        setCurrentUser({ id: session.userId, email: session.email, emailVerifiedAt: session.emailVerifiedAt ?? null });
        setCloudSyncEnabled(false);
        setAppState('app');
        return;
      }
      clearLocalAuthTokens();
      clearSession();
      setCurrentUser(null);
      setCloudSyncEnabled(false);
      setAppState('auth');
    });
    return () => setAuthFailureHandler(null);
  }, []);

  // On mount: restore native storage, then restore the access token using the refresh cookie/token.
  useEffect(() => {
    if (appState !== 'loading') return;
    let cancelled = false;
    async function restoreSession() {
      try {
        await restoreNativeStorageWithTimeout([SESSION_KEY, 'taskflow_logged_in', 'taskflow_user_email', 'taskflow_refresh_token', ACCENT_THEME_KEY]);
        if (cancelled) return;

        const session = loadSession();
        const canUseSession = !!session && !!session.userId && !session.signedOut && !isSessionExpired(session);

        // If user explicitly logged out or session is invalid, skip refresh and go to auth
        if (!canUseSession && session?.signedOut) {
          clearLocalAuthTokens();
          setCloudSyncEnabled(false);
          setAppState('auth');
          return;
        }

        const refreshResult = await apiRefreshDetailed();
        if (cancelled) return;
        if (refreshResult === 'ok') {
          const refreshedUser = getRefreshedUser();
          if (!refreshedUser) {
            clearLocalAuthTokens();
            clearSession();
            setCloudSyncEnabled(false);
            setAppState('auth');
            return;
          }
          saveSession(refreshedUser);
          setCurrentUser(refreshedUser);
          setCloudSyncEnabled(true);
          setAppState('app');
          return;
        }
        if (refreshResult === 'network' && canUseSession) {
          setCurrentUser({ id: session.userId, email: session.email, emailVerifiedAt: session.emailVerifiedAt ?? null });
          setCloudSyncEnabled(false);
          setAppState('app');
          return;
        }
        if (refreshResult === 'unauthorized' && canUseSession) {
          setCurrentUser({ id: session.userId, email: session.email, emailVerifiedAt: session.emailVerifiedAt ?? null });
          setCloudSyncEnabled(false);
          setAppState('app');
          return;
        }
        clearLocalAuthTokens();
        clearSession();
        setCloudSyncEnabled(false);
        setAppState('auth');
      } catch {
        if (cancelled) return;
        const session = loadSession();
        if (session && session.userId && !session.signedOut && !isSessionExpired(session)) {
          setCurrentUser({ id: session.userId, email: session.email, emailVerifiedAt: session.emailVerifiedAt ?? null });
          setCloudSyncEnabled(false);
          setAppState('app');
          return;
        }
        clearLocalAuthTokens();
        clearSession();
        setCloudSyncEnabled(false);
        setAppState('auth');
      }
    }
    restoreSession();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleAuth(user: AuthUser) {
    (document.activeElement as HTMLElement | null)?.blur();
    syncAppViewportHeight(true);
    setCurrentUser(user);
    saveSession(user);
    setCloudSyncEnabled(true);
    setAppState('app');
  }

  function finishSignedOutSession() {
    clearSession();
    clearLocalAuthTokens();
    setCloudSyncEnabled(false);
    setAppState('auth');
    setCurrentUser(null);
    setIsLoggingOut(false);
  }

  async function handleLogout() {
    if (isLoggingOut) return;
    const confirmed = window.confirm(t('account.signOutConfirm'));
    if (!confirmed) return;
    setIsLoggingOut(true);
    toast(t('account.signingOut'));
    if (cloudSyncEnabled) {
      try { await apiUpdateUserStats(); } catch { /* signing out is a local user choice */ }
    }
    try { await apiLogout(); } catch { /* still clean up locally */ }
    if (currentUser?.id) clearUserLocalCache(currentUser.id);
    finishSignedOutSession();
  }

  if (appState === 'loading') {
    return (
      <div className="app-viewport app-safe-y bg-background flex items-center justify-center overscroll-none">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (appState === 'auth') {
    return <AuthPage onAuth={handleAuth} savedEmail={legacySessionEmail()} />;
  }

  if (!currentUser) {
    return <AuthPage onAuth={handleAuth} savedEmail={legacySessionEmail()} />;
  }

  return (
    <AppShell
      user={currentUser}
      accentTheme={accentTheme}
      onAccentThemeChange={setAccentTheme}
      onLogout={handleLogout}
      onAccountDeleted={finishSignedOutSession}
      isLoggingOut={isLoggingOut}
      cloudSyncEnabled={cloudSyncEnabled}
    />
  );
}
