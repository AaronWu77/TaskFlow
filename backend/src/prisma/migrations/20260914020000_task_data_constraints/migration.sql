ALTER TABLE "Task"
  ADD CONSTRAINT "Task_priority_check" CHECK ("priority" IN ('P1', 'P2', 'P3')) NOT VALID,
  ADD CONSTRAINT "Task_status_check" CHECK ("status" IN ('todo', 'done', 'skipped')) NOT VALID,
  ADD CONSTRAINT "Task_repeatRule_check" CHECK ("repeatRule" IS NULL OR "repeatRule" IN ('none', 'daily', 'weekly', 'monthly')) NOT VALID,
  ADD CONSTRAINT "Task_progress_check" CHECK ("progress" BETWEEN 0 AND 100) NOT VALID,
  ADD CONSTRAINT "Task_sortOrder_check" CHECK ("sortOrder" >= 0) NOT VALID,
  ADD CONSTRAINT "Task_estimateMinutes_check" CHECK ("estimateMinutes" IS NULL OR "estimateMinutes" BETWEEN 1 AND 1440) NOT VALID,
  ADD CONSTRAINT "Task_dueDate_format_check" CHECK ("dueDate" IS NULL OR "dueDate" ~ '^\d{4}-\d{2}-\d{2}$') NOT VALID,
  ADD CONSTRAINT "Task_repeatUntilDate_format_check" CHECK ("repeatUntilDate" IS NULL OR "repeatUntilDate" ~ '^\d{4}-\d{2}-\d{2}$') NOT VALID,
  ADD CONSTRAINT "Task_occurrenceDate_format_check" CHECK ("occurrenceDate" IS NULL OR "occurrenceDate" ~ '^\d{4}-\d{2}-\d{2}$') NOT VALID,
  ADD CONSTRAINT "Task_series_occurrence_pair_check" CHECK (("seriesId" IS NULL) = ("occurrenceDate" IS NULL)) NOT VALID,
  ADD CONSTRAINT "Task_completion_pair_check" CHECK (("status" = 'done') = ("completedAt" IS NOT NULL)) NOT VALID;

ALTER TABLE "Task" VALIDATE CONSTRAINT "Task_priority_check";
ALTER TABLE "Task" VALIDATE CONSTRAINT "Task_status_check";
ALTER TABLE "Task" VALIDATE CONSTRAINT "Task_repeatRule_check";
ALTER TABLE "Task" VALIDATE CONSTRAINT "Task_progress_check";
ALTER TABLE "Task" VALIDATE CONSTRAINT "Task_sortOrder_check";
ALTER TABLE "Task" VALIDATE CONSTRAINT "Task_estimateMinutes_check";
ALTER TABLE "Task" VALIDATE CONSTRAINT "Task_dueDate_format_check";
ALTER TABLE "Task" VALIDATE CONSTRAINT "Task_repeatUntilDate_format_check";
ALTER TABLE "Task" VALIDATE CONSTRAINT "Task_occurrenceDate_format_check";
ALTER TABLE "Task" VALIDATE CONSTRAINT "Task_series_occurrence_pair_check";
ALTER TABLE "Task" VALIDATE CONSTRAINT "Task_completion_pair_check";
