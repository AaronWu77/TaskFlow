ALTER TABLE "Task" ADD COLUMN "completedAt" TEXT;
UPDATE "Task"
SET "completedAt" = "updatedAt"::text
WHERE "status" = 'done' AND "completedAt" IS NULL;
CREATE INDEX "Task_userId_completedAt_idx" ON "Task"("userId", "completedAt");
