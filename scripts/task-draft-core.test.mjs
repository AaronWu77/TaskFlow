import test from 'node:test';
import assert from 'node:assert/strict';
import { patchTaskDraft, snapshotTaskDraft, taskDraftFromFieldValues } from '../src/app/task-draft-core.mjs';

const initialDraft = {
  title: '',
  minutes: '',
  priority: 'P2',
  dueDate: '2026-09-13',
  reminderAt: '',
  repeatRule: 'none',
  repeatUntilDate: '',
  tag: '',
};

test('task draft preserves a committed title when priority changes afterwards', () => {
  const withTitle = patchTaskDraft(initialDraft, { title: '先输入的任务' });
  const withPriority = patchTaskDraft(withTitle, { priority: 'P1' });
  assert.deepEqual(snapshotTaskDraft(withPriority), {
    ...initialDraft,
    title: '先输入的任务',
    priority: 'P1',
  });
});

test('task draft preserves priority when the title is entered afterwards', () => {
  const withPriority = patchTaskDraft(initialDraft, { priority: 'P3' });
  const withTitle = patchTaskDraft(withPriority, { title: '后输入的任务' });
  assert.deepEqual(snapshotTaskDraft(withTitle), {
    ...initialDraft,
    title: '后输入的任务',
    priority: 'P3',
  });
});

test('submitted snapshots are isolated from later draft changes', () => {
  const ready = patchTaskDraft(initialDraft, { title: '稳定快照', priority: 'P1' });
  const submitted = snapshotTaskDraft(ready);
  const editedAgain = patchTaskDraft(ready, { priority: 'P3' });
  assert.equal(submitted.priority, 'P1');
  assert.equal(editedAgain.priority, 'P3');
});

test('submit reads the title and priority atomically from the rendered form', () => {
  const staleReactDraft = patchTaskDraft(initialDraft, { title: '旧标题', priority: 'P2' });
  const submitted = taskDraftFromFieldValues(staleReactDraft, {
    title: '输入法刚提交的标题',
    priority: 'P1',
    dueDate: '2026-09-14',
  });
  assert.equal(submitted.title, '输入法刚提交的标题');
  assert.equal(submitted.priority, 'P1');
  assert.equal(submitted.dueDate, '2026-09-14');
});

test('invalid enum fields cannot corrupt a task draft', () => {
  const submitted = taskDraftFromFieldValues(initialDraft, {
    priority: 'urgent',
    repeatRule: 'yearly',
  });
  assert.equal(submitted.priority, 'P2');
  assert.equal(submitted.repeatRule, 'none');
});
