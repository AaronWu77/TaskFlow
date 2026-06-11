ALTER TABLE "Task" ADD COLUMN "completedAt" TEXT;
CREATE INDEX "Task_userId_completedAt_idx" ON "Task"("userId", "completedAt");
