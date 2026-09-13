import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshConnectionIssue, refreshHttpFailureKind, transportFailureKind } from '../src/app/api-result-core.mjs';

test('refresh HTTP failures are not mislabeled as offline', () => {
  assert.equal(refreshHttpFailureKind(401), 'unauthorized');
  assert.equal(refreshHttpFailureKind(404), 'incompatible');
  assert.equal(refreshHttpFailureKind(426), 'incompatible');
  assert.equal(refreshHttpFailureKind(429), 'rate-limited');
  assert.equal(refreshHttpFailureKind(500), 'service-unavailable');
  assert.equal(refreshHttpFailureKind(503), 'service-unavailable');
});

test('only transport failures use offline connectivity state', () => {
  assert.equal(transportFailureKind({ name: 'AbortError' }, true), 'timeout');
  assert.equal(transportFailureKind(new TypeError('fetch failed'), true), 'transport');
  assert.equal(transportFailureKind(new TypeError('fetch failed'), false), 'offline');
});

test('an online transport failure is presented separately from offline mode', () => {
  assert.equal(refreshConnectionIssue('offline'), 'offline');
  assert.equal(refreshConnectionIssue('transport'), 'network');
  assert.equal(refreshConnectionIssue('timeout'), 'timeout');
  assert.equal(refreshConnectionIssue('service-unavailable'), 'serviceUnavailable');
  assert.equal(refreshConnectionIssue('incompatible'), 'incompatible');
  assert.equal(refreshConnectionIssue('rate-limited'), 'rateLimited');
  assert.equal(refreshConnectionIssue('unauthorized'), null);
});
