// API base URL — points to backend. In development use localhost:3000,
// in production set VITE_API_URL to your server (e.g. https://yourdomain.com/api)
import { Preferences } from '@capacitor/preferences';

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3000';

// Access token stored in memory only (not localStorage) — reduces XSS risk.
// On page refresh, the token is gone; a silent refresh via stored refreshToken re-issues it.
let accessToken: string | null = null;

const REFRESH_TOKEN_KEY = 'taskflow_refresh_token';
const IS_NATIVE = typeof (window as unknown as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor !== 'undefined'
  && (window as unknown as { Capacitor: { isNativePlatform: () => boolean } }).Capacitor.isNativePlatform();

// Callback invoked when both the access token and refresh cookie are expired.
// The App component registers this to transition back to the login screen.
let onAuthFailure: (() => void) | null = null;
export function setAuthFailureHandler(fn: (() => void) | null) { onAuthFailure = fn; }

function setAccessToken(token: string | null) {
  accessToken = token;
}

async function getNativeRefreshToken(): Promise<string | null> {
  if (!IS_NATIVE) return null;
  try {
    const { value } = await Preferences.get({ key: REFRESH_TOKEN_KEY });
    return value;
  } catch {
    return null;
  }
}

function setNativeRefreshToken(token: string | null): void {
  if (!IS_NATIVE) return;
  if (token) Preferences.set({ key: REFRESH_TOKEN_KEY, value: token }).catch(() => { /**/ });
  else Preferences.remove({ key: REFRESH_TOKEN_KEY }).catch(() => { /**/ });
}

/** Attempt a silent token refresh using the httpOnly refresh cookie.
 *  Native Capacitor builds also send a Preferences-backed refresh token because
 *  WKWebView cookie persistence is not reliable across all iOS app restarts.
 *  Returns true if a new access token was obtained, false otherwise. */
export async function apiRefresh(): Promise<boolean> {
  try {
    const nativeRefreshToken = await getNativeRefreshToken();
    const headers: Record<string, string> = {};
    if (nativeRefreshToken) headers.Authorization = `Bearer ${nativeRefreshToken}`;

    const res = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers,
    });
    if (!res.ok) return false;
    const data = await res.json() as { accessToken: string; refreshToken?: string };
    setAccessToken(data.accessToken);
    if (data.refreshToken) setNativeRefreshToken(data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

export function clearLocalAuthTokens(): void {
  setAccessToken(null);
  setNativeRefreshToken(null);
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  let res = await fetch(`${BASE_URL}${path}`, { ...options, headers, credentials: 'include' });

  // Auto-refresh on 401 and retry once
  if (res.status === 401) {
    const refreshed = await apiRefresh();
    if (refreshed && accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
      res = await fetch(`${BASE_URL}${path}`, { ...options, headers, credentials: 'include' });
    } else {
      // Both access token and refresh cookie are expired — force logout
      onAuthFailure?.();
    }
  }

  return res;
}

export interface AuthUser {
  id: string;
  email: string;
}

export async function apiLogin(email: string, password: string): Promise<{ user: AuthUser; accessToken: string }> {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json() as { error: string };
    throw new Error(err.error || 'Login failed');
  }
  const data = await res.json() as { user: AuthUser; accessToken: string; refreshToken?: string };
  setAccessToken(data.accessToken);
  setNativeRefreshToken(data.refreshToken ?? null);
  return data;
}

export async function apiRegister(email: string, password: string): Promise<{ user: AuthUser; accessToken: string }> {
  const res = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json() as { error: string };
    throw new Error(err.error || 'Registration failed');
  }
  const data = await res.json() as { user: AuthUser; accessToken: string; refreshToken?: string };
  setAccessToken(data.accessToken);
  setNativeRefreshToken(data.refreshToken ?? null);
  return data;
}

export async function apiLogout(): Promise<void> {
  try { await fetch(`${BASE_URL}/auth/logout`, { method: 'POST', credentials: 'include' }); } catch { /* */ }
  setAccessToken(null);
  setNativeRefreshToken(null);
}

// ── Task CRUD ──

export interface TaskDTO {
  id: string;
  userId: string;
  title: string;
  priority: string;
  estimateMinutes: number;
  status: string;
  tag: string | null;
  progress: number;
  dueDate: string | null;
  reminderAt: string | null;
  repeatRule: string | null;
  deletedAt: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export async function apiGetTasks(): Promise<TaskDTO[]> {
  const res = await apiFetch('/tasks');
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to fetch tasks' })) as { error: string };
    throw new Error(err.error || 'Failed to fetch tasks');
  }
  return res.json() as Promise<TaskDTO[]>;
}

export async function apiCreateTask(task: {
  title: string;
  priority: string;
  estimateMinutes: number;
  status?: string;
  tag?: string;
  progress?: number;
  dueDate?: string | null;
  reminderAt?: string | null;
  repeatRule?: string | null;
  deletedAt?: string | null;
  sortOrder?: number;
}): Promise<TaskDTO> {
  const res = await apiFetch('/tasks', {
    method: 'POST',
    body: JSON.stringify(task),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to create task' })) as { error: string };
    throw new Error(err.error || 'Failed to create task');
  }
  return res.json() as Promise<TaskDTO>;
}

export async function apiUpdateTask(id: string, data: Partial<{
  title: string;
  priority: string;
  estimateMinutes: number;
  status: string;
  tag: string;
  progress: number;
  dueDate: string | null;
  reminderAt: string | null;
  repeatRule: string | null;
  deletedAt: string | null;
  sortOrder: number;
}>): Promise<TaskDTO> {
  const res = await apiFetch(`/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to update task' })) as { error: string };
    throw new Error(err.error || 'Failed to update task');
  }
  return res.json() as Promise<TaskDTO>;
}

export async function apiDeleteTask(id: string): Promise<void> {
  const res = await apiFetch(`/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new Error('Failed to delete task');
  }
}

export async function apiReorderTasks(order: Array<{ id: string; sortOrder: number }>): Promise<void> {
  const res = await apiFetch('/tasks/reorder', {
    method: 'PUT',
    body: JSON.stringify({ order }),
  });
  if (!res.ok) {
    throw new Error('Failed to reorder tasks');
  }
}

// ── User Stats ──

export interface UserStatsDTO {
  streak: number;
  streakDate: string | null;
  completedToday: string;
  todayCount: number;
}

export async function apiGetUserStats(): Promise<UserStatsDTO> {
  const res = await apiFetch('/user/stats');
  if (!res.ok) {
    throw new Error('Failed to fetch user stats');
  }
  return res.json() as Promise<UserStatsDTO>;
}

export async function apiUpdateUserStats(data: { todayCount: number; streak?: number }): Promise<UserStatsDTO> {
  const res = await apiFetch('/user/stats', {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new Error('Failed to update user stats');
  }
  return res.json() as Promise<UserStatsDTO>;
}
