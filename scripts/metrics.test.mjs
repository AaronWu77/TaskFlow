import assert from 'node:assert/strict';
import { test } from 'node:test';
import { metricsSnapshot, recordHttpMetric, recordSyncMetric } from '../backend/dist/services/metrics.js';

test('metrics expose bounded request percentiles and sync outcome ratios without payloads', () => {
  for (let index = 1; index <= 100; index += 1) recordHttpMetric(index > 95 ? 500 : 200, index);
  recordSyncMetric(80, 15, 5);
  const snapshot = metricsSnapshot();
  assert.equal(snapshot.sampleSize, 100);
  assert.equal(snapshot.requests.serverErrors, 5);
  assert.equal(snapshot.requests.serverErrorRatio, 0.05);
  assert.equal(snapshot.requests.p95DurationMs, 95);
  assert.equal(snapshot.requests.p99DurationMs, 99);
  assert.equal(snapshot.sync.conflictRatio, 0.15);
  assert.equal('tasks' in snapshot, false);
});
