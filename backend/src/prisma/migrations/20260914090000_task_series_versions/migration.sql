ALTER TABLE "Task"
  ADD COLUMN "seriesVersion" INTEGER;

UPDATE "Task" AS task
SET "seriesVersion" = series.version
FROM "TaskSeries" AS series
WHERE task."seriesId" = series.id
  AND task."userId" = series."userId";

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_seriesVersion_positive_check"
  CHECK ("seriesVersion" IS NULL OR "seriesVersion" > 0) NOT VALID;

ALTER TABLE "Task" VALIDATE CONSTRAINT "Task_seriesVersion_positive_check";
