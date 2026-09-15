const DATABASE_NAME = 'taskflow-local-v1';
const DATABASE_VERSION = 1;
const LOCAL_SCHEMA_VERSION = 1;

type AccountSnapshot<TTask = unknown, TOperation = unknown, TMeta = unknown> = {
  tasks: TTask[];
  pendingOperations: TOperation[];
  syncMeta: TMeta;
};

const commitChains = new Map<string, Promise<void>>();
const committedSnapshots = new Map<string, AccountSnapshot<{ id: string }, { operationId: string }, unknown>>();
type PendingCommit = {
  snapshot: AccountSnapshot<{ id: string }, { operationId: string }, unknown>;
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
};
const pendingCommits = new Map<string, PendingCommit>();

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

function accountRange(userId: string): IDBKeyRange {
  return IDBKeyRange.bound([userId, ''], [userId, '\uffff']);
}

async function openDatabase(): Promise<IDBDatabase> {
  if (!('indexedDB' in globalThis)) throw new Error('IndexedDB is unavailable');
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains('local_tasks')) {
      database.createObjectStore('local_tasks', { keyPath: ['userId', 'id'] });
    }
    if (!database.objectStoreNames.contains('pending_operations')) {
      database.createObjectStore('pending_operations', { keyPath: ['userId', 'id'] });
    }
    if (!database.objectStoreNames.contains('sync_meta')) {
      database.createObjectStore('sync_meta', { keyPath: 'userId' });
    }
    if (!database.objectStoreNames.contains('account_meta')) {
      database.createObjectStore('account_meta', { keyPath: 'userId' });
    }
    if (!database.objectStoreNames.contains('quarantine')) {
      database.createObjectStore('quarantine', { keyPath: 'id' });
    }
  };
  return requestResult(request);
}

async function commitNow<TTask extends { id: string }, TOperation extends { operationId: string }, TMeta>(
  userId: string,
  snapshot: AccountSnapshot<TTask, TOperation, TMeta>,
  replace = false,
): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(['local_tasks', 'pending_operations', 'sync_meta', 'account_meta'], 'readwrite', { durability: 'strict' });
    try {
      const tasks = transaction.objectStore('local_tasks');
      const operations = transaction.objectStore('pending_operations');
      const previous = replace ? undefined : committedSnapshots.get(userId);
      if (!previous) {
        tasks.delete(accountRange(userId));
        operations.delete(accountRange(userId));
        for (const task of snapshot.tasks) tasks.put({ userId, id: task.id, value: task });
        for (const operation of snapshot.pendingOperations) operations.put({ userId, id: operation.operationId, value: operation });
      } else {
        const previousTasks = new Map(previous.tasks.map(task => [task.id, task]));
        const nextTaskIds = new Set(snapshot.tasks.map(task => task.id));
        for (const task of previous.tasks) {
          if (!nextTaskIds.has(task.id)) tasks.delete([userId, task.id]);
        }
        for (const task of snapshot.tasks) {
          if (previousTasks.get(task.id) !== task) tasks.put({ userId, id: task.id, value: task });
        }

        const previousOperations = new Map(previous.pendingOperations.map(operation => [operation.operationId, operation]));
        const nextOperationIds = new Set(snapshot.pendingOperations.map(operation => operation.operationId));
        for (const operation of previous.pendingOperations) {
          if (!nextOperationIds.has(operation.operationId)) operations.delete([userId, operation.operationId]);
        }
        for (const operation of snapshot.pendingOperations) {
          if (previousOperations.get(operation.operationId) !== operation) {
            operations.put({ userId, id: operation.operationId, value: operation });
          }
        }
      }
      transaction.objectStore('sync_meta').put({ userId, value: snapshot.syncMeta });
      transaction.objectStore('account_meta').put({
        userId,
        schemaVersion: LOCAL_SCHEMA_VERSION,
        migrationComplete: true,
        taskCount: snapshot.tasks.length,
        operationCount: snapshot.pendingOperations.length,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      transaction.abort();
      await transactionComplete(transaction).catch(() => undefined);
      throw error;
    }
    await transactionComplete(transaction);
    committedSnapshots.set(userId, snapshot as AccountSnapshot<{ id: string }, { operationId: string }, unknown>);
  } finally {
    database.close();
  }
}

export async function loadRepositoryAccount<TTask, TOperation, TMeta>(userId: string): Promise<AccountSnapshot<TTask, TOperation, TMeta> | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(['local_tasks', 'pending_operations', 'sync_meta', 'account_meta'], 'readonly');
    const metaRequest = transaction.objectStore('account_meta').get(userId);
    const tasksRequest = transaction.objectStore('local_tasks').getAll(accountRange(userId));
    const operationsRequest = transaction.objectStore('pending_operations').getAll(accountRange(userId));
    const syncRequest = transaction.objectStore('sync_meta').get(userId);
    const [meta, taskRows, operationRows, syncRow] = await Promise.all([
      requestResult(metaRequest), requestResult(tasksRequest), requestResult(operationsRequest), requestResult(syncRequest),
    ]);
    await transactionComplete(transaction);
    if (!meta?.migrationComplete || meta.schemaVersion !== LOCAL_SCHEMA_VERSION || !syncRow) return null;
    const tasks = taskRows.map(row => row.value) as TTask[];
    const pendingOperations = operationRows.map(row => row.value) as TOperation[];
    if (tasks.length !== meta.taskCount || pendingOperations.length !== meta.operationCount) {
      throw new Error('IndexedDB account snapshot failed its count invariant');
    }
    const snapshot = { tasks, pendingOperations, syncMeta: syncRow.value as TMeta };
    committedSnapshots.set(userId, snapshot as AccountSnapshot<{ id: string }, { operationId: string }, unknown>);
    return snapshot;
  } finally {
    database.close();
  }
}

function drainPendingCommit(userId: string): void {
  const pending = pendingCommits.get(userId);
  if (!pending) return;
  pendingCommits.delete(userId);
  const previous = commitChains.get(userId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => commitNow(userId, pending.snapshot));
  commitChains.set(userId, next);
  void next.then(
    () => pending.waiters.forEach(waiter => waiter.resolve()),
    error => pending.waiters.forEach(waiter => waiter.reject(error)),
  ).finally(() => {
    if (commitChains.get(userId) === next) commitChains.delete(userId);
  });
}

export function commitRepositoryAccount<TTask extends { id: string }, TOperation extends { operationId: string }, TMeta>(
  userId: string,
  snapshot: AccountSnapshot<TTask, TOperation, TMeta>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const normalizedSnapshot = snapshot as AccountSnapshot<{ id: string }, { operationId: string }, unknown>;
    const pending = pendingCommits.get(userId);
    if (pending) {
      pending.snapshot = normalizedSnapshot;
      pending.waiters.push({ resolve, reject });
      return;
    }
    pendingCommits.set(userId, { snapshot: normalizedSnapshot, waiters: [{ resolve, reject }] });
    queueMicrotask(() => drainPendingCommit(userId));
  });
}

export async function migrateRepositoryAccount<TTask extends { id: string }, TOperation extends { operationId: string }, TMeta extends { syncCursor: number }>(
  userId: string,
  legacy: AccountSnapshot<TTask, TOperation, TMeta>,
): Promise<AccountSnapshot<TTask, TOperation, TMeta>> {
  const existing = await loadRepositoryAccount<TTask, TOperation, TMeta>(userId);
  if (existing) {
    const existingOperationIds = new Set(existing.pendingOperations.map(operation => operation.operationId));
    const fallbackContainsNewerLocalWork = legacy.pendingOperations.some(operation => !existingOperationIds.has(operation.operationId));
    if (!fallbackContainsNewerLocalWork) return existing;
    const previous = commitChains.get(userId) ?? Promise.resolve();
    const recoveryCommit = previous.catch(() => undefined).then(() => commitNow(userId, legacy, true));
    commitChains.set(userId, recoveryCommit);
    await recoveryCommit.finally(() => {
      if (commitChains.get(userId) === recoveryCommit) commitChains.delete(userId);
    });
    return (await loadRepositoryAccount<TTask, TOperation, TMeta>(userId)) ?? legacy;
  }
  const previous = commitChains.get(userId) ?? Promise.resolve();
  const migrationCommit = previous.catch(() => undefined).then(() => commitNow(userId, legacy, true));
  commitChains.set(userId, migrationCommit);
  await migrationCommit.finally(() => {
    if (commitChains.get(userId) === migrationCommit) commitChains.delete(userId);
  });
  const verified = await loadRepositoryAccount<TTask, TOperation, TMeta>(userId);
  const expectedIds = legacy.pendingOperations.map(operation => operation.operationId).sort();
  const actualIds = verified?.pendingOperations.map(operation => operation.operationId).sort();
  if (!verified || verified.tasks.length !== legacy.tasks.length
    || JSON.stringify(actualIds) !== JSON.stringify(expectedIds)
    || verified.syncMeta.syncCursor !== legacy.syncMeta.syncCursor) {
    await quarantineRepositoryValue(userId, 'legacy-migration-verification-failed', legacy);
    throw new Error('Local repository migration verification failed');
  }
  return verified;
}

export async function quarantineRepositoryValue(userId: string, reason: string, raw: unknown): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction('quarantine', 'readwrite', { durability: 'strict' });
    transaction.objectStore('quarantine').put({
      id: `${userId}:${Date.now()}:${crypto.randomUUID()}`,
      userId,
      reason,
      raw,
      createdAt: new Date().toISOString(),
    });
    await transactionComplete(transaction);
    committedSnapshots.delete(userId);
  } finally {
    database.close();
  }
}

export async function flushRepositoryWrites(): Promise<void> {
  for (const userId of [...pendingCommits.keys()]) drainPendingCommit(userId);
  await Promise.allSettled([...commitChains.values()]);
}

export async function clearRepositoryAccount(userId: string): Promise<void> {
  drainPendingCommit(userId);
  await (commitChains.get(userId) ?? Promise.resolve()).catch(() => undefined);
  const database = await openDatabase();
  try {
    const transaction = database.transaction(['local_tasks', 'pending_operations', 'sync_meta', 'account_meta'], 'readwrite', { durability: 'strict' });
    transaction.objectStore('local_tasks').delete(accountRange(userId));
    transaction.objectStore('pending_operations').delete(accountRange(userId));
    transaction.objectStore('sync_meta').delete(userId);
    transaction.objectStore('account_meta').delete(userId);
    await transactionComplete(transaction);
    committedSnapshots.delete(userId);
  } finally {
    database.close();
  }
}
