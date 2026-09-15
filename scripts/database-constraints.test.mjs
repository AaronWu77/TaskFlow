import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const migration = readFileSync(new URL('../backend/src/prisma/migrations/20260914020000_task_data_constraints/migration.sql', import.meta.url), 'utf8');
const typedMigration = readFileSync(new URL('../backend/src/prisma/migrations/20260914040000_task_typed_date_shadows/migration.sql', import.meta.url), 'utf8');
const seriesVersionMigration = readFileSync(new URL('../backend/src/prisma/migrations/20260914090000_task_series_versions/migration.sql', import.meta.url), 'utf8');
const seriesExclusionMigration = readFileSync(new URL('../backend/src/prisma/migrations/20260914100000_series_schedule_exclusions/migration.sql', import.meta.url), 'utf8');

test('database migration constrains task enums, ranges, recurrence identity, and completion state', () => {
  for (const constraint of [
    'Task_priority_check', 'Task_status_check', 'Task_repeatRule_check', 'Task_progress_check',
    'Task_sortOrder_check', 'Task_estimateMinutes_check', 'Task_dueDate_format_check',
    'Task_repeatUntilDate_format_check', 'Task_occurrenceDate_format_check',
    'Task_series_occurrence_pair_check', 'Task_completion_pair_check',
  ]) {
    assert.match(migration, new RegExp(`ADD CONSTRAINT "${constraint}"`));
    assert.match(migration, new RegExp(`VALIDATE CONSTRAINT "${constraint}"`));
  }
  assert.match(migration, /"progress" BETWEEN 0 AND 100/);
  assert.match(migration, /\("seriesId" IS NULL\) = \("occurrenceDate" IS NULL\)/);
  assert.match(migration, /\("status" = 'done'\) = \("completedAt" IS NOT NULL\)/);
});

test('typed date shadows are backfilled, dual-written, and validated before legacy removal', () => {
  for (const column of ['dueDateTyped', 'reminderAtTyped', 'repeatUntilDateTyped', 'occurrenceDateTyped', 'completedAtTyped', 'deletedAtTyped']) {
    assert.match(typedMigration, new RegExp(`ADD COLUMN "${column}"`));
  }
  assert.match(typedMigration, /CREATE TRIGGER "Task_sync_date_shadows"/);
  assert.match(typedMigration, /VALIDATE CONSTRAINT "Task_dueDate_shadow_check"/);
  assert.match(typedMigration, /VALIDATE CONSTRAINT "Task_reminderAt_shadow_check"/);
});

test('series task versions are backfilled and constrained to positive values', () => {
  assert.match(seriesVersionMigration, /ADD COLUMN "seriesVersion" INTEGER/);
  assert.match(seriesVersionMigration, /FROM "TaskSeries" AS series/);
  assert.match(seriesVersionMigration, /"seriesVersion" IS NULL OR "seriesVersion" > 0/);
  assert.match(seriesVersionMigration, /VALIDATE CONSTRAINT "Task_seriesVersion_positive_check"/);
});

test('series schedule exclusions are distinguishable from user deletions', () => {
  assert.match(seriesExclusionMigration, /ADD COLUMN "scheduleExcludedAt" TIMESTAMPTZ\(3\)/);
  assert.match(seriesExclusionMigration, /Task_userId_seriesId_scheduleExcludedAt_idx/);
});
