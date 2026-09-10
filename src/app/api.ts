// API base URL — override with VITE_API_URL when targeting a different backend.
import { Capacitor } from '@capacitor/core';
import { createSingleFlight } from './sync-core.mjs';
import { secureGet, secureRemove, secureSet } from './secure-storage';

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'https://taskflow.top/api';

// Access token stored in memory only (not localStorage) — reduces XSS risk.
// On page refresh, the token is gone; a silent refresh via stored refreshToken re-issues it.
let accessToken: string | null = null;

const REFRESH_TOKEN_KEY = 'taskflow_refresh_token';
export type RefreshResult = 'ok' | 'unauthorized' | 'network';
const IS_NATIVE_PLATFORM = Capacitor.isNativePlatform();
const REQUEST_TIMEOUT_MS = 15000;
let refreshedUser: AuthUser | null = null;

export class ApiError extends Error {
  status: number;
  code?: string;
  data?: unknown;

  constructor(message: string, status: number, code?: string, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export function isTaskConflictError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 && error.code === 'TASK_CONFLICT';
}

// Callback invoked when both the access token and refresh cookie are expired.
// The App component registers this to transition back to the login screen.
let onAuthFailure: (() => void) | null = null;
export function setAuthFailureHandler(fn: (() => void) | null) { onAuthFailure = fn; }

function setAccessToken(token: string | null) {
  accessToken = token;
}

async function getStoredRefreshToken(): Promise<string | null> {
  return IS_NATIVE_PLATFORM ? secureGet(REFRESH_TOKEN_KEY) : null;
}

async function setStoredRefreshToken(token: string | null): Promise<void> {
  if (IS_NATIVE_PLATFORM) {
    if (token) await secureSet(REFRESH_TOKEN_KEY, token);
    else await secureRemove(REFRESH_TOKEN_KEY);
  } else {
    // Remove tokens written by older web builds. Web sessions use only the httpOnly cookie.
    try {
      localStorage.removeItem(REFRESH_TOKEN_KEY);
    } catch { /**/ }
  }
}

function platformHeaders(): Record<string, string> {
  return IS_NATIVE_PLATFORM ? { 'X-TaskFlow-Platform': 'native' } : {};
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

/** Attempt a silent token refresh using the httpOnly refresh cookie plus a stored fallback token.
 *  The fallback keeps dev web and Capacitor sessions alive when cookies are not persisted. */
async function performRefresh(): Promise<RefreshResult> {
  try {
    if (!IS_NATIVE_PLATFORM) await setStoredRefreshToken(null);
    const storedRefreshToken = await getStoredRefreshToken();
    const headers: Record<string, string> = platformHeaders();
    if (storedRefreshToken) headers.Authorization = `Bearer ${storedRefreshToken}`;

    const res = await fetchWithTimeout(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers,
    });
    if (!res.ok) return res.status === 401 ? 'unauthorized' : 'network';
    const data = await res.json() as { accessToken: string; refreshToken?: string; user?: AuthUser };
    setAccessToken(data.accessToken);
    refreshedUser = data.user ?? null;
    if (data.refreshToken) await setStoredRefreshToken(data.refreshToken);
    return 'ok';
  } catch {
    return 'network';
  }
}

const runRefreshSingleFlight = createSingleFlight(performRefresh);

export async function apiRefreshDetailed(): Promise<RefreshResult> {
  return runRefreshSingleFlight();
}

export function getRefreshedUser(): AuthUser | null {
  return refreshedUser;
}

export async function apiRefresh(): Promise<boolean> {
  return (await apiRefreshDetailed()) === 'ok';
}

export function clearLocalAuthTokens(): void {
  setAccessToken(null);
  void setStoredRefreshToken(null);
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  let res = await fetchWithTimeout(`${BASE_URL}${path}`, { ...options, headers, credentials: 'include' });

  // Auto-refresh on 401 and retry once
  if (res.status === 401) {
    const refreshResult = await apiRefreshDetailed();
    if (refreshResult === 'ok' && accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
      res = await fetchWithTimeout(`${BASE_URL}${path}`, { ...options, headers, credentials: 'include' });
    } else if (refreshResult === 'unauthorized') {
      onAuthFailure?.();
    }
  }

  return res;
}

export interface AuthUser {
  id: string;
  email: string;
  emailVerifiedAt?: string | null;
  emailVerified?: boolean;
  displayName?: string | null;
  timezone?: string | null;
  locale?: string | null;
}

export interface AuthSuccess {
  user: AuthUser;
  accessToken: string;
}

export interface AuthVerificationRequired {
  requiresEmailVerification: true;
  user: AuthUser;
  devCode?: string;
}

export type AuthResult = AuthSuccess | AuthVerificationRequired;

function isVerificationRequired(data: unknown): data is AuthVerificationRequired {
  return !!data && typeof data === 'object' && (data as { requiresEmailVerification?: unknown }).requiresEmailVerification === true;
}

async function parseAuthResponse(res: Response, fallback: string): Promise<AuthResult> {
  const data = await res.json().catch(() => ({ error: fallback })) as {
    error?: string;
    code?: string;
    user?: AuthUser;
    accessToken?: string;
    refreshToken?: string;
    requiresEmailVerification?: boolean;
    devCode?: string;
  };
  if (!res.ok) {
    if (isVerificationRequired(data) && data.user) return data;
    throw new ApiError(('error' in data ? data.error : undefined) || fallback, res.status, 'code' in data ? data.code : undefined, data);
  }
  if (data.requiresEmailVerification && data.user) {
    return { requiresEmailVerification: true, user: data.user, devCode: data.devCode };
  }
  if (!data.accessToken || !data.user) throw new Error(fallback);
  setAccessToken(data.accessToken);
  await setStoredRefreshToken(data.refreshToken ?? null);
  return { user: data.user, accessToken: data.accessToken };
}

export async function apiLogin(email: string, password: string): Promise<AuthResult> {
  const res = await fetchWithTimeout(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...platformHeaders() },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  });
  return parseAuthResponse(res, 'Login failed');
}

export async function apiRegister(email: string, password: string): Promise<AuthResult> {
  const res = await fetchWithTimeout(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...platformHeaders() },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  });
  return parseAuthResponse(res, 'Registration failed');
}

export async function apiVerifyEmail(email: string, code: string): Promise<AuthSuccess> {
  const res = await fetchWithTimeout(`${BASE_URL}/auth/verify-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...platformHeaders() },
    credentials: 'include',
    body: JSON.stringify({ email, code }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Email verification failed' })) as { error?: string; code?: string };
    throw new ApiError(err.error || 'Email verification failed', res.status, err.code, err);
  }
  const data = await res.json() as { user: AuthUser; accessToken: string; refreshToken?: string };
  setAccessToken(data.accessToken);
  await setStoredRefreshToken(data.refreshToken ?? null);
  return data;
}

export async function apiResendVerification(email: string): Promise<{ ok: true; devCode?: string; alreadyVerified?: boolean }> {
  const res = await fetchWithTimeout(`${BASE_URL}/auth/resend-verification`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...platformHeaders() },
    credentials: 'include',
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to resend verification code' })) as { error?: string; code?: string };
    throw new ApiError(err.error || 'Failed to resend verification code', res.status, err.code, err);
  }
  return res.json() as Promise<{ ok: true; devCode?: string; alreadyVerified?: boolean }>;
}

export async function apiLogout(): Promise<void> {
  try {
    const refreshToken = await getStoredRefreshToken();
    await fetchWithTimeout(`${BASE_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { ...platformHeaders(), ...(refreshToken ? { Authorization: `Bearer ${refreshToken}` } : {}) },
    });
  } catch { /* local sign-out must still complete */ }
  setAccessToken(null);
  await setStoredRefreshToken(null);
}

// ── Task CRUD ──

export interface TaskDTO {
  id: string;
  userId: string;
  title: string;
  priority: string;
  estimateMinutes: number | null;
  status: string;
  tag: string | null;
  dueDate: string | null;
  reminderAt: string | null;
  repeatRule: string | null;
  repeatUntilDate: string | null;
  completedAt: string | null;
  deletedAt: string | null;
  sortOrder: number;
  version: number;
  lastChangedByDeviceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyncChangeDTO {
  id: string;
  userId: string;
  seq: number;
  taskId: string | null;
  operationId: string | null;
  deviceId: string | null;
  type: string;
  snapshot: TaskDTO | { order?: Array<{ id: string; sortOrder: number }>; taskOrderVersion?: number } | null;
  tombstone: { taskId?: string; deletedAt?: string | null; permanentlyDeletedAt?: string; version?: number } | null;
  createdAt: string;
}

export interface UserStatsDTO {
  streak: number;
  streakDate: string | null;
  completedToday: string;
  todayCount: number;
}

export interface SyncBootstrapDTO {
  tasks: TaskDTO[];
  deletedTasks: TaskDTO[];
  userStats: UserStatsDTO | null;
  currentCursor: number;
  taskOrderVersion: number;
  serverTime: string;
}

export interface PendingSyncOperationDTO {
  operationId: string;
  type: string;
  taskId?: string;
  clientTaskId?: string;
  baseVersion?: number | null;
  baseOrderVersion?: number | null;
  payload?: unknown;
}

export interface SyncPushResponseDTO {
  accepted: Array<{ operationId: string; task?: TaskDTO; change?: SyncChangeDTO; clientTaskId?: string; order?: { order: Array<{ id: string; sortOrder: number }>; taskOrderVersion: number }; tombstone?: unknown; replayed?: boolean }>;
  conflicts: Array<{ operationId: string; code: string; serverTask?: TaskDTO; serverVersion?: number; clientOperation?: PendingSyncOperationDTO; serverOrderVersion?: number }>;
  rejected: Array<{ operationId?: string; code: string; error: string }>;
  nextCursorHint: number;
}

export async function apiSyncBootstrap(): Promise<SyncBootstrapDTO> {
  const res = await apiFetch('/sync/bootstrap');
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to bootstrap sync' })) as { error?: string; code?: string };
    throw new ApiError(err.error || 'Failed to bootstrap sync', res.status, err.code, err);
  }
  return res.json() as Promise<SyncBootstrapDTO>;
}

export async function apiPullChanges(cursor: number, limit = 500): Promise<{ changes: SyncChangeDTO[]; nextCursor: number; hasMore: boolean; serverTime: string }> {
  const res = await apiFetch(`/sync?cursor=${encodeURIComponent(String(cursor))}&limit=${encodeURIComponent(String(limit))}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to pull sync changes' })) as { error?: string; code?: string };
    throw new ApiError(err.error || 'Failed to pull sync changes', res.status, err.code, err);
  }
  return res.json() as Promise<{ changes: SyncChangeDTO[]; nextCursor: number; hasMore: boolean; serverTime: string }>;
}

export async function apiPushOperations(deviceId: string, operations: PendingSyncOperationDTO[]): Promise<SyncPushResponseDTO> {
  const res = await apiFetch('/sync/push', {
    method: 'POST',
    body: JSON.stringify({ deviceId, operations }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to push sync operations' })) as { error?: string; code?: string };
    throw new ApiError(err.error || 'Failed to push sync operations', res.status, err.code, err);
  }
  return res.json() as Promise<SyncPushResponseDTO>;
}

// ── User Stats ──

export async function apiGetUserStats(): Promise<UserStatsDTO> {
  const res = await apiFetch('/user/stats');
  if (!res.ok) {
    throw new Error('Failed to fetch user stats');
  }
  return res.json() as Promise<UserStatsDTO>;
}

export async function apiUpdateUserStats(): Promise<UserStatsDTO> {
  const res = await apiFetch('/user/stats', {
    method: 'PATCH',
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error('Failed to update user stats');
  }
  return res.json() as Promise<UserStatsDTO>;
}

export async function apiDeleteAccount(): Promise<void> {
  const res = await apiFetch('/user/account', { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new Error('Failed to delete account');
  }
  setAccessToken(null);
  await setStoredRefreshToken(null);
}

export async function apiExportUserData(): Promise<Blob> {
  const res = await apiFetch('/user/export', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new ApiError('Failed to export account data', res.status);
  return res.blob();
}

export async function apiUpdateUserPreferences(preferences: { timezone?: string; locale?: 'zh' | 'en'; displayName?: string }): Promise<AuthUser> {
  const res = await apiFetch('/user/preferences', {
    method: 'PATCH',
    body: JSON.stringify(preferences),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Failed to update preferences' })) as { error?: string; code?: string };
    throw new ApiError(error.error || 'Failed to update preferences', res.status, error.code, error);
  }
  return res.json() as Promise<AuthUser>;
}
