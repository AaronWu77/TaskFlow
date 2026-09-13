export function classifySyncError(error) {
  const status = typeof error?.status === 'number' ? error.status : null;
  const code = typeof error?.code === 'string' ? error.code : null;
  if (status === 409 && code === 'TASK_CONFLICT') return 'conflict';
  if (status === 404) return 'missing';
  if (status !== null && status >= 400 && status < 500) return 'invalid';
  return 'retryable';
}

export function takeSyncBatch(operations, isReady, limit = 50, dependencyKey = () => null) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 50;
  const ready = operations.filter(isReady);
  const claimedDependencies = new Set();
  const batch = [];
  for (const operation of ready) {
    const key = dependencyKey(operation);
    if (key !== null && claimedDependencies.has(key)) continue;
    if (key !== null) claimedDependencies.add(key);
    batch.push(operation);
    if (batch.length >= safeLimit) break;
  }
  return {
    batch,
    hasMore: ready.length > batch.length,
  };
}

export function syncRetryDelay(attempt, random = Math.random) {
  const normalizedAttempt = Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
  const base = Math.min(30_000, 750 * (2 ** Math.min(normalizedAttempt - 1, 6)));
  const jitter = Math.max(0, Math.min(1, Number(random()) || 0));
  return Math.round(base * (0.85 + jitter * 0.3));
}
