-- Expand: add native date/time shadows while retaining the legacy text columns.
ALTER TABLE "Task"
  ADD COLUMN "dueDateTyped" DATE,
  ADD COLUMN "reminderAtTyped" TIMESTAMPTZ(3),
  ADD COLUMN "repeatUntilDateTyped" DATE,
  ADD COLUMN "occurrenceDateTyped" DATE,
  ADD COLUMN "completedAtTyped" TIMESTAMPTZ(3),
  ADD COLUMN "deletedAtTyped" TIMESTAMPTZ(3);

-- Backfill. Invalid legacy values intentionally fail this migration instead of
-- being silently converted or dropped.
UPDATE "Task"
SET
  "dueDateTyped" = "dueDate"::date,
  "reminderAtTyped" = "reminderAt"::timestamptz,
  "repeatUntilDateTyped" = "repeatUntilDate"::date,
  "occurrenceDateTyped" = "occurrenceDate"::date,
  "completedAtTyped" = "completedAt"::timestamptz,
  "deletedAtTyped" = "deletedAt"::timestamptz;

-- Keep old and new application versions compatible during the dual-write
-- window. Whichever representation changed becomes authoritative.
CREATE OR REPLACE FUNCTION taskflow_sync_task_date_shadows()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."dueDateTyped" := COALESCE(NEW."dueDateTyped", NEW."dueDate"::date);
    NEW."reminderAtTyped" := COALESCE(NEW."reminderAtTyped", NEW."reminderAt"::timestamptz);
    NEW."repeatUntilDateTyped" := COALESCE(NEW."repeatUntilDateTyped", NEW."repeatUntilDate"::date);
    NEW."occurrenceDateTyped" := COALESCE(NEW."occurrenceDateTyped", NEW."occurrenceDate"::date);
    NEW."completedAtTyped" := COALESCE(NEW."completedAtTyped", NEW."completedAt"::timestamptz);
    NEW."deletedAtTyped" := COALESCE(NEW."deletedAtTyped", NEW."deletedAt"::timestamptz);
  ELSE
    IF NEW."dueDate" IS DISTINCT FROM OLD."dueDate" THEN NEW."dueDateTyped" := NEW."dueDate"::date;
    ELSIF NEW."dueDateTyped" IS DISTINCT FROM OLD."dueDateTyped" THEN NEW."dueDate" := to_char(NEW."dueDateTyped", 'YYYY-MM-DD'); END IF;
    IF NEW."reminderAt" IS DISTINCT FROM OLD."reminderAt" THEN NEW."reminderAtTyped" := NEW."reminderAt"::timestamptz;
    ELSIF NEW."reminderAtTyped" IS DISTINCT FROM OLD."reminderAtTyped" THEN NEW."reminderAt" := to_char(NEW."reminderAtTyped" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'); END IF;
    IF NEW."repeatUntilDate" IS DISTINCT FROM OLD."repeatUntilDate" THEN NEW."repeatUntilDateTyped" := NEW."repeatUntilDate"::date;
    ELSIF NEW."repeatUntilDateTyped" IS DISTINCT FROM OLD."repeatUntilDateTyped" THEN NEW."repeatUntilDate" := to_char(NEW."repeatUntilDateTyped", 'YYYY-MM-DD'); END IF;
    IF NEW."occurrenceDate" IS DISTINCT FROM OLD."occurrenceDate" THEN NEW."occurrenceDateTyped" := NEW."occurrenceDate"::date;
    ELSIF NEW."occurrenceDateTyped" IS DISTINCT FROM OLD."occurrenceDateTyped" THEN NEW."occurrenceDate" := to_char(NEW."occurrenceDateTyped", 'YYYY-MM-DD'); END IF;
    IF NEW."completedAt" IS DISTINCT FROM OLD."completedAt" THEN NEW."completedAtTyped" := NEW."completedAt"::timestamptz;
    ELSIF NEW."completedAtTyped" IS DISTINCT FROM OLD."completedAtTyped" THEN NEW."completedAt" := to_char(NEW."completedAtTyped" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'); END IF;
    IF NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt" THEN NEW."deletedAtTyped" := NEW."deletedAt"::timestamptz;
    ELSIF NEW."deletedAtTyped" IS DISTINCT FROM OLD."deletedAtTyped" THEN NEW."deletedAt" := to_char(NEW."deletedAtTyped" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'); END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Task_sync_date_shadows"
BEFORE INSERT OR UPDATE ON "Task"
FOR EACH ROW EXECUTE FUNCTION taskflow_sync_task_date_shadows();

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_dueDate_shadow_check" CHECK (("dueDate" IS NULL) = ("dueDateTyped" IS NULL) AND ("dueDate" IS NULL OR "dueDate"::date = "dueDateTyped")) NOT VALID,
  ADD CONSTRAINT "Task_reminderAt_shadow_check" CHECK (("reminderAt" IS NULL) = ("reminderAtTyped" IS NULL) AND ("reminderAt" IS NULL OR "reminderAt"::timestamptz = "reminderAtTyped")) NOT VALID,
  ADD CONSTRAINT "Task_repeatUntilDate_shadow_check" CHECK (("repeatUntilDate" IS NULL) = ("repeatUntilDateTyped" IS NULL) AND ("repeatUntilDate" IS NULL OR "repeatUntilDate"::date = "repeatUntilDateTyped")) NOT VALID,
  ADD CONSTRAINT "Task_occurrenceDate_shadow_check" CHECK (("occurrenceDate" IS NULL) = ("occurrenceDateTyped" IS NULL) AND ("occurrenceDate" IS NULL OR "occurrenceDate"::date = "occurrenceDateTyped")) NOT VALID,
  ADD CONSTRAINT "Task_completedAt_shadow_check" CHECK (("completedAt" IS NULL) = ("completedAtTyped" IS NULL) AND ("completedAt" IS NULL OR "completedAt"::timestamptz = "completedAtTyped")) NOT VALID,
  ADD CONSTRAINT "Task_deletedAt_shadow_check" CHECK (("deletedAt" IS NULL) = ("deletedAtTyped" IS NULL) AND ("deletedAt" IS NULL OR "deletedAt"::timestamptz = "deletedAtTyped")) NOT VALID;

ALTER TABLE "Task" VALIDATE CONSTRAINT "Task_dueDate_shadow_check";
ALTER TABLE "Task" VALIDATE CONSTRAINT "Task_reminderAt_shadow_check";
ALTER TABLE "Task" VALIDATE CONSTRAINT "Task_repeatUntilDate_shadow_check";
ALTER TABLE "Task" VALIDATE CONSTRAINT "Task_occurrenceDate_shadow_check";
ALTER TABLE "Task" VALIDATE CONSTRAINT "Task_completedAt_shadow_check";
ALTER TABLE "Task" VALIDATE CONSTRAINT "Task_deletedAt_shadow_check";

CREATE INDEX "Task_userId_dueDateTyped_idx" ON "Task"("userId", "dueDateTyped");
CREATE INDEX "Task_userId_completedAtTyped_idx" ON "Task"("userId", "completedAtTyped");
CREATE INDEX "Task_userId_deletedAtTyped_idx" ON "Task"("userId", "deletedAtTyped");
