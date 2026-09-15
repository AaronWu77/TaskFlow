-- Distinguish occurrences hidden by a series schedule change from tasks the
-- user deliberately deleted. Only schedule exclusions may be restored when a
-- later series edit includes the same stable occurrence identity again.
ALTER TABLE "Task"
  ADD COLUMN "scheduleExcludedAt" TIMESTAMPTZ(3);

CREATE INDEX "Task_userId_seriesId_scheduleExcludedAt_idx"
  ON "Task"("userId", "seriesId", "scheduleExcludedAt");
