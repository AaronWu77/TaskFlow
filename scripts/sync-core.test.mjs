import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifySyncError, syncRetryDelay, takeSyncBatch } from '../src/app/sync-core.mjs';

test('sync retry delay backs off, adds bounded jitter, and caps at thirty seconds', () => {
  assert.equal(syncRetryDelay(1, () => 0.5), 750);
  assert.equal(syncRetryDelay(2, () => 0.5), 1500);
  assert.equal(syncRetryDelay(20, () => 0.5), 30000);
  assert.ok(syncRetryDelay(1, () => 0) < syncRetryDelay(1, () => 1));
});

test('sync batching never exceeds the API limit and reports remaining ready work', () => {
  const operations = Array.from({ length: 137 }, (_, index) => ({ id: index, ready: index % 3 !== 0 }));
  const first = takeSyncBatch(operations, operation => operation.ready, 50);
  assert.equal(first.batch.length, 50);
  assert.equal(first.batch.every(operation => operation.ready), true);
  assert.equal(first.hasMore, true);

  const final = takeSyncBatch(operations.slice(0, 40), operation => operation.ready, 50);
  assert.equal(final.batch.length, 26);
  assert.equal(final.hasMore, false);
});

test('a batch serializes writes that target the same task or global order', () => {
  const operations = [
    { id: 'a1', taskId: 'a', type: 'update' },
    { id: 'a2', taskId: 'a', type: 'restore' },
    { id: 'b1', taskId: 'b', type: 'update' },
    { id: 'r1', type: 'reorder' },
    { id: 'r2', type: 'reorder' },
  ];
  const { batch, hasMore } = takeSyncBatch(
    operations,
    () => true,
    50,
    operation => operation.taskId ? `task:${operation.taskId}` : operation.type === 'reorder' ? 'order' : null,
  );
  assert.deepEqual(batch.map(operation => operation.id), ['a1', 'b1', 'r1']);
  assert.equal(hasMore, true);
});

for (const operationCount of [99, 100, 101, 366]) {
  test(`${operationCount} ready operations drain in ordered 50-item batches`, () => {
    let remaining = Array.from({ length: operationCount }, (_, index) => ({ id: index }));
    const drained = [];
    while (remaining.length > 0) {
      const { batch, hasMore } = takeSyncBatch(remaining, () => true, 50);
      assert.ok(batch.length > 0 && batch.length <= 50);
      drained.push(...batch);
      remaining = remaining.slice(batch.length);
      assert.equal(hasMore, remaining.length > 0);
    }
    assert.deepEqual(drained.map(operation => operation.id), Array.from({ length: operationCount }, (_, index) => index));
  });
}

test('sync errors distinguish conflicts, missing records, invalid writes, and retryable failures', () => {
  assert.equal(classifySyncError({ status: 409, code: 'TASK_CONFLICT' }), 'conflict');
  assert.equal(classifySyncError({ status: 404 }), 'missing');
  assert.equal(classifySyncError({ status: 422 }), 'invalid');
  assert.equal(classifySyncError({ status: 503 }), 'retryable');
  assert.equal(classifySyncError(new TypeError('network failed')), 'retryable');
});
