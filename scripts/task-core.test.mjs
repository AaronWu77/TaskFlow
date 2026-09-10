import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_REPEAT_INSTANCES,
  nextRepeatDate,
  repeatDatesAfterStart,
  repeatInstanceCount,
} from '../src/app/task-core.mjs';

test('monthly recurrence clamps short months without drifting the anchor day', () => {
  assert.equal(nextRepeatDate('2025-01-31', 'monthly'), '2025-02-28');
  assert.deepEqual(
    repeatDatesAfterStart('2025-01-31', '2025-04-30', 'monthly'),
    ['2025-02-28', '2025-03-31', '2025-04-30'],
  );
  assert.equal(nextRepeatDate('2024-01-31', 'monthly'), '2024-02-29');
});

test('repeat generation is bounded and counts the starting task', () => {
  assert.equal(repeatInstanceCount('2025-01-01', '2025-01-01', 'daily'), 0);
  assert.equal(repeatInstanceCount('2025-01-01', '2025-01-03', 'daily'), 3);
  const dates = repeatDatesAfterStart('2020-01-01', '2030-01-01', 'daily');
  assert.equal(dates.length, MAX_REPEAT_INSTANCES);
});

test('weekly recurrence crosses month and year boundaries correctly', () => {
  assert.equal(nextRepeatDate('2025-12-29', 'weekly'), '2026-01-05');
});
