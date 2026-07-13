import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifySyncError, createSingleFlight, logoutBlockReason, mergeFlushResult } from '../src/app/sync-core.mjs';

test('a newer edit keeps its fields and absorbs the server version from the older response', () => {
  const before = [{ id: 'task-1', title: 'first edit', updatedAt: 'T1', _dirty: true, _syncState: 'update', _operationId: 'op-a' }];
  const current = [{ id: 'task-1', title: 'second edit', updatedAt: 'T1', _dirty: true, _syncState: 'update', _operationId: 'op-b' }];
  const flushed = [{ id: 'task-1', title: 'first edit', updatedAt: 'T2', completedAt: null, _dirty: false }];

  assert.deepEqual(mergeFlushResult(current, before, flushed), [{
    ...current[0],
    updatedAt: 'T2',
    completedAt: null,
  }]);
});

test('an edited local create accepts the server id and remains a pending update', () => {
  const before = [{ id: 'local-1', _clientKey: 'client-1', title: 'draft', _dirty: true, _syncState: 'create', _operationId: 'op-create' }];
  const current = [{ ...before[0], title: 'new title', _operationId: 'op-edit' }];
  const flushed = [{ ...before[0], id: 'server-1', updatedAt: 'T2', _dirty: false, _syncState: undefined, _operationId: undefined }];
  const [result] = mergeFlushResult(current, before, flushed);

  assert.equal(result.id, 'server-1');
  assert.equal(result.title, 'new title');
  assert.equal(result.updatedAt, 'T2');
  assert.equal(result._operationId, 'op-edit');
  assert.equal(result._syncState, 'update');
  assert.equal(result._dirty, true);
});

test('a confirmed permanent delete is removed only for the matching operation', () => {
  const before = [{ id: 'task-1', _dirty: true, _syncState: 'permanent-delete', _operationId: 'op-delete' }];
  assert.deepEqual(mergeFlushResult(before, before, []), []);

  const newer = [{ ...before[0], _operationId: 'op-newer' }];
  assert.deepEqual(mergeFlushResult(newer, before, []), newer);
});

test('sync errors distinguish conflicts, missing records, invalid writes, and retryable failures', () => {
  assert.equal(classifySyncError({ status: 409, code: 'TASK_CONFLICT' }), 'conflict');
  assert.equal(classifySyncError({ status: 404 }), 'missing');
  assert.equal(classifySyncError({ status: 422 }), 'invalid');
  assert.equal(classifySyncError({ status: 503 }), 'retryable');
  assert.equal(classifySyncError(new TypeError('network failed')), 'retryable');
});

test('single-flight shares one operation across concurrent callers and resets afterward', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const run = createSingleFlight(async () => {
    calls += 1;
    await gate;
    return calls;
  });

  const first = run();
  const second = run();
  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 1]);
  assert.equal(await run(), 2);
});

test('logout is blocked whenever unsynced data cannot be confirmed by the server', () => {
  const clean = [{ id: 'task-1', _dirty: false }];
  const dirty = [{ id: 'task-1', _dirty: true }];
  assert.equal(logoutBlockReason(clean, false), null);
  assert.equal(logoutBlockReason(dirty, false), 'offline');
  assert.equal(logoutBlockReason(dirty, true), 'pending');
});
