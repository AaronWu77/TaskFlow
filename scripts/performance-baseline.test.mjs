import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTodoOrder, normalizeTodoSortOrder } from '../src/app/task-core.mjs';

function fixture(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `task-${index}`,
    title: `Task ${index}`,
    priority: index % 3 === 0 ? 'P1' : index % 3 === 1 ? 'P2' : 'P3',
    status: 'todo',
    deletedAt: null,
    sortOrder: count - index - 1,
  }));
}

test('task ordering performance remains bounded at 10, 100, 500, and 1,000 rows', () => {
  const measurements = [];
  for (const count of [10, 100, 500, 1000]) {
    const tasks = fixture(count);
    const startedAt = performance.now();
    const normalized = normalizeTodoSortOrder(tasks);
    const reversed = normalized.toReversed().map((task, sortOrder) => ({ id: task.id, sortOrder }));
    const applied = applyTodoOrder(normalized, reversed);
    const elapsedMs = performance.now() - startedAt;
    assert.equal(applied.length, count);
    assert.equal(new Set(applied.map(task => task.id)).size, count);
    assert.deepEqual(applied.map(task => task.sortOrder), Array.from({ length: count }, (_, index) => index));
    measurements.push({ count, elapsedMs });
  }
  const thousand = measurements.find(item => item.count === 1000);
  assert.ok(thousand.elapsedMs < 250, `1,000-row ordering took ${thousand.elapsedMs.toFixed(1)}ms`);
});
