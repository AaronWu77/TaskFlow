import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_REPEAT_INSTANCES,
  applyTodoOrder,
  nextRepeatDate,
  normalizeTodoSortOrder,
  repeatDatesAfterStart,
  repeatInstanceCount,
} from '../src/app/task-core.mjs';

test('pending order normalization is contiguous and excludes completed or deleted tasks', () => {
  const tasks = [
    { id: 'a', status: 'todo', deletedAt: null, sortOrder: 7 },
    { id: 'b', status: 'done', deletedAt: null, sortOrder: 2 },
    { id: 'c', status: 'todo', deletedAt: '2026-01-01', sortOrder: 9 },
    { id: 'd', status: 'todo', deletedAt: null, sortOrder: 7 },
  ];
  assert.deepEqual(normalizeTodoSortOrder(tasks), [
    { ...tasks[0], sortOrder: 0 },
    tasks[1],
    tasks[2],
    { ...tasks[3], sortOrder: 1 },
  ]);
});

test('a remote order snapshot changes render order and preserves unsynced local tasks', () => {
  const tasks = [
    { id: 'a', status: 'todo', deletedAt: null, sortOrder: 0 },
    { id: 'local-new', status: 'todo', deletedAt: null, sortOrder: 1 },
    { id: 'b', status: 'todo', deletedAt: null, sortOrder: 2 },
    { id: 'done', status: 'done', deletedAt: null, sortOrder: 0 },
  ];
  const reordered = applyTodoOrder(tasks, [
    { id: 'b', sortOrder: 0 },
    { id: 'a', sortOrder: 1 },
  ]);
  assert.deepEqual(reordered.map(task => task.id), ['b', 'a', 'local-new', 'done']);
  assert.deepEqual(reordered.slice(0, 3).map(task => task.sortOrder), [0, 1, 1]);
});

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
