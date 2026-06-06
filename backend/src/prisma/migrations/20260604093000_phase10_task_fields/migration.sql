ALTER TABLE "Task" ADD COLUMN "reminderAt" TEXT;
ALTER TABLE "Task" ADD COLUMN "repeatRule" TEXT;
ALTER TABLE "Task" ADD COLUMN "deletedAt" TEXT;

CREATE INDEX "Task_userId_deletedAt_idx" ON "Task"("userId", "deletedAt");
