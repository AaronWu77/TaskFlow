CREATE TABLE "TaskOperation" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taskId" TEXT,
    "type" TEXT NOT NULL,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TaskOperation_operationId_key" ON "TaskOperation"("operationId");
CREATE INDEX "TaskOperation_userId_idx" ON "TaskOperation"("userId");
CREATE INDEX "TaskOperation_taskId_idx" ON "TaskOperation"("taskId");
CREATE INDEX "TaskOperation_createdAt_idx" ON "TaskOperation"("createdAt");

ALTER TABLE "TaskOperation" ADD CONSTRAINT "TaskOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
