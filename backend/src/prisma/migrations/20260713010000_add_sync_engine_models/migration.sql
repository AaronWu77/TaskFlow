-- Development-stage sync engine schema. This migration intentionally introduces
-- the new multi-device sync model without preserving the old client protocol.

ALTER TABLE "Task"
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "lastChangedByDeviceId" TEXT;

CREATE TABLE "Device" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT,
  "platform" TEXT,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserSyncState" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "nextSeq" INTEGER NOT NULL DEFAULT 1,
  "taskOrderVersion" INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT "UserSyncState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaskChange" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "taskId" TEXT,
  "operationId" TEXT,
  "deviceId" TEXT,
  "type" TEXT NOT NULL,
  "snapshot" JSONB,
  "tombstone" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TaskChange_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserSyncState_userId_key" ON "UserSyncState"("userId");
CREATE UNIQUE INDEX "TaskChange_operationId_key" ON "TaskChange"("operationId");
CREATE UNIQUE INDEX "TaskChange_userId_seq_key" ON "TaskChange"("userId", "seq");

CREATE INDEX "Task_userId_version_idx" ON "Task"("userId", "version");
CREATE INDEX "Device_userId_idx" ON "Device"("userId");
CREATE INDEX "Device_lastSeenAt_idx" ON "Device"("lastSeenAt");
CREATE INDEX "TaskChange_userId_idx" ON "TaskChange"("userId");
CREATE INDEX "TaskChange_taskId_idx" ON "TaskChange"("taskId");
CREATE INDEX "TaskChange_createdAt_idx" ON "TaskChange"("createdAt");

ALTER TABLE "Device"
ADD CONSTRAINT "Device_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserSyncState"
ADD CONSTRAINT "UserSyncState_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskChange"
ADD CONSTRAINT "TaskChange_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
