import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeSyncState, encodeSyncState, selectNewestSyncState } from '../src/app/sync-state-core.mjs';

const payload = {
  tasks: [{ id: 'task-1', title: 'one' }],
  pendingOperations: [{ operationId: 'op-1', type: 'create' }],
  syncMeta: { syncCursor: 4, taskOrderVersion: 2, lastSuccessfulSyncAt: '' },
};

test('sync state envelope round-trips a complete task, queue, and cursor snapshot', () => {
  assert.deepEqual(decodeSyncState(encodeSyncState(payload, 7)), { revision: 7, payload });
});

test('sync state rejects truncation and checksum mismatches', () => {
  const encoded = encodeSyncState(payload, 1);
  assert.equal(decodeSyncState(encoded.slice(0, -3)), null);
  assert.equal(decodeSyncState(encoded.replace('task-1', 'task-2')), null);
});

test('dual-slot recovery selects the newest valid revision and falls back after corruption', () => {
  const oldState = encodeSyncState({ ...payload, syncMeta: { ...payload.syncMeta, syncCursor: 3 } }, 3);
  const newState = encodeSyncState(payload, 4);
  assert.equal(selectNewestSyncState(oldState, newState).revision, 4);
  assert.equal(selectNewestSyncState(oldState, `${newState}broken`).revision, 3);
});
