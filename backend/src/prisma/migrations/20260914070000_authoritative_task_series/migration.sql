CREATE TABLE "TaskSeries" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "priority" TEXT NOT NULL,
  "estimateMinutes" INTEGER,
  "tag" TEXT,
  "repeatRule" TEXT NOT NULL,
  "startDate" DATE NOT NULL,
  "untilDate" DATE NOT NULL,
  "timezone" TEXT NOT NULL,
  "reminderAt" TIMESTAMPTZ(3),
  "generatedThrough" DATE,
  "version" INTEGER NOT NULL DEFAULT 1,
  "deletedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskSeries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaskSeries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskSeries_priority_check" CHECK ("priority" IN ('P1', 'P2', 'P3')),
  CONSTRAINT "TaskSeries_repeatRule_check" CHECK ("repeatRule" IN ('daily', 'weekly', 'monthly')),
  CONSTRAINT "TaskSeries_estimate_check" CHECK ("estimateMinutes" IS NULL OR "estimateMinutes" BETWEEN 1 AND 1440),
  CONSTRAINT "TaskSeries_version_check" CHECK ("version" > 0),
  CONSTRAINT "TaskSeries_range_check" CHECK ("untilDate" >= "startDate")
);

CREATE INDEX "TaskSeries_userId_deletedAt_idx" ON "TaskSeries"("userId", "deletedAt");
CREATE INDEX "TaskSeries_userId_generatedThrough_idx" ON "TaskSeries"("userId", "generatedThrough");
