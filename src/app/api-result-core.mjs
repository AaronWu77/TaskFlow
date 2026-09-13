export function refreshHttpFailureKind(status) {
  if (status === 401) return 'unauthorized';
  if (status === 404 || status === 426) return 'incompatible';
  if (status === 429) return 'rate-limited';
  return 'service-unavailable';
}

export function transportFailureKind(error, online) {
  if (error && typeof error === 'object' && error.name === 'AbortError') return 'timeout';
  return online ? 'transport' : 'offline';
}

export function refreshConnectionIssue(kind) {
  if (kind === 'offline') return 'offline';
  if (kind === 'transport') return 'network';
  if (kind === 'timeout') return 'timeout';
  if (kind === 'service-unavailable') return 'serviceUnavailable';
  if (kind === 'incompatible') return 'incompatible';
  if (kind === 'rate-limited') return 'rateLimited';
  return null;
}
