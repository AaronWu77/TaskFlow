import test from 'node:test';
import assert from 'node:assert/strict';
import { createReorderFeedback, reorderIndexChange } from '../src/app/reorder-feedback.mjs';

test('reorder feedback fires only when the dragged item crosses a slot', () => {
  assert.deepEqual(
    reorderIndexChange(['a', 'b', 'c'], ['b', 'a', 'c'], 'a'),
    { previousIndex: 0, nextIndex: 1, changed: true },
  );
  assert.equal(reorderIndexChange(['b', 'a', 'c'], ['b', 'a', 'c'], 'a').changed, false);
});

test('reorder feedback ignores unrelated array changes and missing drag state', () => {
  assert.equal(reorderIndexChange(['a', 'b', 'c'], ['a', 'c', 'b'], 'a').changed, false);
  assert.equal(reorderIndexChange(['a', 'b'], ['b', 'a'], null).changed, false);
  assert.equal(reorderIndexChange(['a', 'b'], ['b', 'a'], 'missing').changed, false);
});

test('feedback controller balances selection lifecycle and deduplicates slot feedback', () => {
  const calls = { start: 0, change: 0, end: 0 };
  const feedback = createReorderFeedback({
    start: () => { calls.start += 1; },
    change: () => { calls.change += 1; },
    end: () => { calls.end += 1; },
  });

  feedback.start('a', ['a', 'b', 'c']);
  feedback.change(['b', 'a', 'c']);
  feedback.change(['b', 'a', 'c']);
  feedback.end();
  feedback.end();

  assert.deepEqual(calls, { start: 1, change: 1, end: 1 });
  assert.equal(feedback.isActive(), false);
});

test('reset ends an active selection before replacing external order', () => {
  const events = [];
  const feedback = createReorderFeedback({
    start: () => events.push('start'),
    change: () => events.push('change'),
    end: () => events.push('end'),
  });
  feedback.start('b', ['a', 'b']);
  feedback.reset(['b', 'a']);
  feedback.change(['a', 'b']);
  assert.deepEqual(events, ['start', 'end']);
});
