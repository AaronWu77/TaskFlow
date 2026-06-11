// API base URL — points to backend. In development use localhost:3000,
// in production set VITE_API_URL to your server (e.g. https://yourdomain.com/api)
import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3000';

// Access token stored in memory only (not localStorage) — reduces XSS risk.
// On page refresh, the token is gone; a silent refresh via stored refreshToken re-issues it.
let accessToken: string | null = null;

const REFRESH_TOKEN_KEY = 'taskflow_refresh_token';
export type RefreshResult = 'ok' | 'unauthorized' | 'network';
const IS_NATIVE_PLATFORM = Capacitor.isNativePlatform();
let refreshedUser: AuthUser | null = null;

// Callback invoked when both the access token and refresh cookie are expired.
// The App component registers this to transition back to the login screen.
let onAuthFailure: (() => void) | null = null;
export function setAuthFailureHandler(fn: (() => void) | null) { onAuthFailure = fn; }

function setAccessToken(token: string | null) {
  accessToken = token;
}

async function getStoredRefreshToken(): Promise<string | null> {
  if (IS_NATIVE_PLATFORM) {
    try {
      const { value } = await Preferences.get({ key: REFRESH_TOKEN_KEY });
      return value;
    } catch {
      return null;
    }
  }
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

function setStoredRefreshToken(token: string | null): void {
  if (IS_NATIVE_PLATFORM) {
    if (token) Preferences.set({ key: REFRESH_TOKEN_KEY, value: token }).catch(() => { /**/ });
    else Preferences.remove({ key: REFRESH_TOKEN_KEY }).catch(() => { /**/ });
  } else {
    try {
      if (token) localStorage.setItem(REFRESH_TOKEN_KEY, token);
      else localStorage.removeItem(REFRESH_TOKEN_KEY);
    } catch { /**/ }
  }
}

/** Attempt a silent token refresh using the httpOnly refresh cookie plus a stored fallback token.
 *  The fallback keeps dev web and Capacitor sessions alive when cookies are not persisted. */
export async function apiRefreshDetailed(): Promise<RefreshResult> {
  try {
    const storedRefreshToken = await getStoredRefreshToken();
    const headers: Record<string, string> = {};
    if (storedRefreshToken) headers.Authorization = `Bearer ${storedRefreshToken}`;

    const res = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers,
    });
    if (!res.ok) return res.status === 401 ? 'unauthorized' : 'network';
    const data = await res.json() as { accessToken: string; refreshToken?: string; user?: AuthUser };
    setAccessToken(data.accessToken);
    refreshedUser = data.user ?? null;
    if (data.refreshToken) setStoredRefreshToken(data.refreshToken);
    return 'ok';
  } catch {
    return 'network';
  }
}

export function getRefreshedUser(): AuthUser | null {
  return refreshedUser;
}

export async function apiRefresh(): Promise<boolean> {
  return (await apiRefreshDetailed()) === 'ok';
}

export function clearLocalAuthTokens(): void {
  setAccessToken(null);
  setStoredRefreshToken(null);
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
    const refreshResult = await apiRefreshDetailed();
    if (refreshResult === 'ok' && accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
      res = await fetch(`${BASE_URL}${path}`, { ...options, headers, credentials: 'include' });
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
    user?: AuthUser;
    accessToken?: string;
    refreshToken?: string;
    requiresEmailVerification?: boolean;
    devCode?: string;
  };
  if (!res.ok) {
    if (isVerificationRequired(data) && data.user) return data;
    throw new Error(data.error || fallback);
  }
  if (data.requiresEmailVerification && data.user) {
    return { requiresEmailVerification: true, user: data.user, devCode: data.devCode };
  }
  if (!data.accessToken || !data.user) throw new Error(fallback);
  setAccessToken(data.accessToken);
  setStoredRefreshToken(data.refreshToken ?? null);
  return { user: data.user, accessToken: data.accessToken };
}

export async function apiLogin(email: string, password: string): Promise<AuthResult> {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  });
  return parseAuthResponse(res, 'Login failed');
}

export async function apiRegister(email: string, password: string): Promise<AuthResult> {
  const res = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  });
  return parseAuthResponse(res, 'Registration failed');
}

export async function apiVerifyEmail(email: string, code: string): Promise<AuthSuccess> {
  const res = await fetch(`${BASE_URL}/auth/verify-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, code }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Email verification failed' })) as { error: string };
    throw new Error(err.error || 'Email verification failed');
  }
  const data = await res.json() as { user: AuthUser; accessToken: string; refreshToken?: string };
  setAccessToken(data.accessToken);
  setStoredRefreshToken(data.refreshToken ?? null);
  return data;
}

export async function apiResendVerification(email: string): Promise<{ ok: true; devCode?: string; alreadyVerified?: boolean }> {
  const res = await fetch(`${BASE_URL}/auth/resend-verification`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to resend verification code' })) as { error: string };
    throw new Error(err.error || 'Failed to resend verification code');
  }
  return res.json() as Promise<{ ok: true; devCode?: string; alreadyVerified?: boolean }>;
}

export async function apiLogout(): Promise<void> {
  try { await fetch(`${BASE_URL}/auth/logout`, { method: 'POST', credentials: 'include' }); } catch { /* */ }
  setAccessToken(null);
  setStoredRefreshToken(null);
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
