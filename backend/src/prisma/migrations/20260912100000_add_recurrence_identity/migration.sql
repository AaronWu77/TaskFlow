-- Existing repeated tasks are intentionally left unlinked: inferring a series
-- from title/date could merge unrelated user data. Newly created series receive
-- explicit identities from the client.
ALTER TABLE "Task"
ADD COLUMN "seriesId" TEXT,
ADD COLUMN "occurrenceDate" TEXT;

CREATE INDEX "Task_userId_seriesId_idx"
ON "Task"("userId", "seriesId");

CREATE UNIQUE INDEX "Task_userId_seriesId_occurrenceDate_key"
ON "Task"("userId", "seriesId", "occurrenceDate");
