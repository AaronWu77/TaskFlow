CREATE TABLE "UserDailyStats" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserDailyStats_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserDailyStats_count_nonnegative" CHECK ("count" >= 0),
  CONSTRAINT "UserDailyStats_date_format" CHECK ("date" ~ '^\d{4}-\d{2}-\d{2}$'),
  CONSTRAINT "UserDailyStats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "UserDailyStats_userId_date_key" ON "UserDailyStats"("userId", "date");
CREATE INDEX "UserDailyStats_userId_date_idx" ON "UserDailyStats"("userId", "date");

INSERT INTO "UserDailyStats" ("id", "userId", "date", "count", "createdAt", "updatedAt")
SELECT
  md5(task."userId" || ':' || ((task."completedAtTyped" AT TIME ZONE COALESCE("User"."timezone", 'UTC'))::date)::text),
  task."userId",
  ((task."completedAtTyped" AT TIME ZONE COALESCE("User"."timezone", 'UTC'))::date)::text,
  COUNT(*)::integer,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Task" AS task
JOIN "User" ON "User"."id" = task."userId"
WHERE task."status" = 'done'
  AND task."deletedAtTyped" IS NULL
  AND task."completedAtTyped" IS NOT NULL
GROUP BY task."userId", ((task."completedAtTyped" AT TIME ZONE COALESCE("User"."timezone", 'UTC'))::date)::text;
