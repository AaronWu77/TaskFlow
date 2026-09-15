import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'node:test';
import {
  clearRepositoryAccount,
  commitRepositoryAccount,
  loadRepositoryAccount,
  migrateRepositoryAccount,
} from '../src/app/local-task-repository.ts';

const meta = { syncCursor: 4, taskOrderVersion: 2, protocolVersion: 2, snapshotId: 'snapshot', lastSuccessfulSyncAt: '' };

test('repository commits tasks, operations, and cursor atomically and migration is idempotent', async () => {
  const userId = 'repository-atomic-user';
  await clearRepositoryAccount(userId);
  const original = {
    tasks: [{ id: 'task-1', title: 'original' }],
    pendingOperations: [{ operationId: 'op-1', type: 'create' }],
    syncMeta: meta,
  };
  await migrateRepositoryAccount(userId, original);
  assert.deepEqual(await loadRepositoryAccount(userId), original);

  const ignoredSecondMigration = {
    tasks: [{ id: 'task-duplicate', title: 'must not import' }],
    pendingOperations: [],
    syncMeta: { ...meta, syncCursor: 0 },
  };
  assert.deepEqual(await migrateRepositoryAccount(userId, ignoredSecondMigration), original);

  await assert.rejects(commitRepositoryAccount(userId, {
    tasks: [{ title: 'missing primary key aborts transaction' }],
    pendingOperations: [{ operationId: 'op-should-not-commit', type: 'update' }],
    syncMeta: { ...meta, syncCursor: 99 },
  }));
  assert.deepEqual(await loadRepositoryAccount(userId), original);
});

test('repository handles 1,000 tasks and 1,000 operations without losing identities', async () => {
  const userId = 'repository-volume-user';
  await clearRepositoryAccount(userId);
  const snapshot = {
    tasks: Array.from({ length: 1000 }, (_, index) => ({ id: `task-${index}`, title: `Task ${index}` })),
    pendingOperations: Array.from({ length: 1000 }, (_, index) => ({ operationId: `op-${index}`, type: 'update', taskId: `task-${index}` })),
    syncMeta: { ...meta, syncCursor: 1000 },
  };
  const startedAt = performance.now();
  await commitRepositoryAccount(userId, snapshot);
  const restored = await loadRepositoryAccount(userId);
  const elapsedMs = performance.now() - startedAt;
  assert.equal(restored.tasks.length, 1000);
  assert.equal(restored.pendingOperations.length, 1000);
  assert.equal(new Set(restored.pendingOperations.map(operation => operation.operationId)).size, 1000);
  assert.ok(elapsedMs < 5000, `repository round-trip took ${elapsedMs.toFixed(1)}ms`);

  const changedTask = { ...snapshot.tasks[500], title: 'Only this row changed' };
  const changedOperation = { ...snapshot.pendingOperations[500], retryCount: 1 };
  const deltaSnapshot = {
    tasks: snapshot.tasks.with(500, changedTask),
    pendingOperations: snapshot.pendingOperations.with(500, changedOperation),
    syncMeta: { ...snapshot.syncMeta, syncCursor: 1001 },
  };
  const deltaStartedAt = performance.now();
  await commitRepositoryAccount(userId, deltaSnapshot);
  const deltaElapsedMs = performance.now() - deltaStartedAt;
  const afterDelta = await loadRepositoryAccount(userId);
  assert.equal(afterDelta.tasks.find(task => task.id === 'task-500').title, 'Only this row changed');
  assert.equal(afterDelta.pendingOperations.find(operation => operation.operationId === 'op-500').retryCount, 1);
  assert.ok(deltaElapsedMs < 1000, `repository delta commit took ${deltaElapsedMs.toFixed(1)}ms`);
});

test('repository coalesces one UI mutation into the final task and operation envelope', async () => {
  const userId = 'repository-coalesced-user';
  await clearRepositoryAccount(userId);
  await commitRepositoryAccount(userId, { tasks: [], pendingOperations: [], syncMeta: meta });

  const task = { id: 'task-created', title: 'Created locally' };
  const operation = { operationId: 'op-created', type: 'create', taskId: task.id };
  const taskWrite = commitRepositoryAccount(userId, {
    tasks: [task],
    pendingOperations: [],
    syncMeta: meta,
  });
  const completeWrite = commitRepositoryAccount(userId, {
    tasks: [task],
    pendingOperations: [operation],
    syncMeta: meta,
  });
  await Promise.all([taskWrite, completeWrite]);

  assert.deepEqual(await loadRepositoryAccount(userId), {
    tasks: [task],
    pendingOperations: [operation],
    syncMeta: meta,
  });
});

test('migration recovers a pagehide checkpoint that contains newer pending work', async () => {
  const userId = 'repository-pagehide-recovery-user';
  await clearRepositoryAccount(userId);
  await commitRepositoryAccount(userId, { tasks: [], pendingOperations: [], syncMeta: meta });
  const fallback = {
    tasks: [{ id: 'task-before-reload', title: 'Must survive reload' }],
    pendingOperations: [{ operationId: 'op-before-reload', type: 'create' }],
    syncMeta: meta,
  };

  assert.deepEqual(await migrateRepositoryAccount(userId, fallback), fallback);
  assert.deepEqual(await loadRepositoryAccount(userId), fallback);
});
