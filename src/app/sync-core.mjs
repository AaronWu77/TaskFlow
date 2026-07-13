export function classifySyncError(error) {
  const status = typeof error?.status === 'number' ? error.status : null;
  const code = typeof error?.code === 'string' ? error.code : null;
  if (status === 409 && code === 'TASK_CONFLICT') return 'conflict';
  if (status === 404) return 'missing';
  if (status !== null && status >= 400 && status < 500) return 'invalid';
  return 'retryable';
}

export function createSingleFlight(operation) {
  let inFlight = null;
  return function run() {
    if (!inFlight) {
      inFlight = Promise.resolve().then(operation).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}

export function logoutBlockReason(tasks, cloudSyncEnabled) {
  if (!tasks.some(task => task._dirty)) return null;
  return cloudSyncEnabled ? 'pending' : 'offline';
}

export function mergeFlushResult(current, before, flushed) {
  const merged = [...current];
  for (const original of before.filter(task => task._dirty)) {
    const currentIndex = merged.findIndex(task => task.id === original.id || (original._clientKey && task._clientKey === original._clientKey));
    if (currentIndex < 0) continue;
    const currentTask = merged[currentIndex];
    const result = flushed.find(task => task.id === original.id || (original._clientKey && task._clientKey === original._clientKey));
    if (!result) {
      if (original._syncState === 'permanent-delete' && currentTask._operationId === original._operationId) {
        merged.splice(currentIndex, 1);
      }
      continue;
    }

    if (currentTask._operationId !== original._operationId) {
      if (!result._dirty) {
        merged[currentIndex] = {
          ...currentTask,
          ...(original.id.startsWith('local-') ? { id: result.id } : {}),
          updatedAt: result.updatedAt,
          completedAt: result.completedAt,
          _dirty: true,
          _syncState: original.id.startsWith('local-') ? 'update' : currentTask._syncState,
        };
      }
      continue;
    }

    merged[currentIndex] = result._dirty
      ? {
          ...currentTask,
          _conflict: result._conflict || currentTask._conflict,
          _syncError: result._syncError || currentTask._syncError,
        }
      : { ...currentTask, ...result, _clientKey: currentTask._clientKey };
  }
  return merged;
}
