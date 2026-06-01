// API base URL — points to backend. In development use localhost:3000,
// in production set VITE_API_URL to your server (e.g. https://yourdomain.com/api)
const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3000';

// Access token stored in memory only (not localStorage) — reduces XSS risk.
// On page refresh, the token is gone; a silent refresh via httpOnly cookie re-issues it.
let accessToken: string | null = null;

// Callback invoked when both the access token and refresh cookie are expired.
// The App component registers this to transition back to the login screen.
let onAuthFailure: (() => void) | null = null;
export function setAuthFailureHandler(fn: (() => void) | null) { onAuthFailure = fn; }

function setAccessToken(token: string | null) {
  accessToken = token;
}

/** Attempt a silent token refresh using the httpOnly refresh cookie.
 *  Returns true if a new access token was obtained, false otherwise. */
export async function apiRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return false;
    const data = await res.json() as { accessToken: string };
    setAccessToken(data.accessToken);
    return true;
  } catch {
    return false;
  }
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
  const data = await res.json() as { user: AuthUser; accessToken: string };
  setAccessToken(data.accessToken);
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
  const data = await res.json() as { user: AuthUser; accessToken: string };
  setAccessToken(data.accessToken);
  return data;
}

export async function apiLogout(): Promise<void> {
  await fetch(`${BASE_URL}/auth/logout`, { method: 'POST', credentials: 'include' });
  setAccessToken(null);
}
