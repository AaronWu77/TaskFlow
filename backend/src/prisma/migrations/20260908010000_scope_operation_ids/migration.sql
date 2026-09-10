DROP INDEX IF EXISTS "TaskChange_operationId_key";
DROP INDEX IF EXISTS "TaskOperation_operationId_key";

CREATE UNIQUE INDEX "TaskChange_userId_operationId_key"
ON "TaskChange"("userId", "operationId");

CREATE UNIQUE INDEX "TaskOperation_userId_operationId_key"
ON "TaskOperation"("userId", "operationId");

-- Preserve idempotency for operations accepted before TaskOperation became the
-- canonical replay ledger.
INSERT INTO "TaskOperation" ("id", "operationId", "userId", "taskId", "type", "response", "createdAt")
SELECT
  'backfill:' || "id",
  "operationId",
  "userId",
  "taskId",
  "type",
  jsonb_build_object('operationId', "operationId", 'change', to_jsonb("TaskChange")) ||
    CASE
      WHEN "type" = 'reorder' THEN jsonb_build_object('order', "snapshot")
      WHEN "type" = 'permanent-delete' THEN jsonb_build_object('tombstone', "tombstone")
      ELSE jsonb_build_object('task', "snapshot")
    END,
  "createdAt"
FROM "TaskChange"
WHERE "operationId" IS NOT NULL
ON CONFLICT ("userId", "operationId") DO NOTHING;
