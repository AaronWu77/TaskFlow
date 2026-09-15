ALTER TABLE "User"
  ADD COLUMN "deleteScheduledFor" TIMESTAMP(3),
  ADD COLUMN "passwordChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "RefreshSession"
  ADD COLUMN "familyId" TEXT,
  ADD COLUMN "deviceName" TEXT,
  ADD COLUMN "platform" TEXT,
  ADD COLUMN "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "RefreshSession" SET "familyId" = "id" WHERE "familyId" IS NULL;
ALTER TABLE "RefreshSession" ALTER COLUMN "familyId" SET NOT NULL;

CREATE INDEX "RefreshSession_userId_familyId_idx" ON "RefreshSession"("userId", "familyId");
CREATE INDEX "RefreshSession_userId_lastSeenAt_idx" ON "RefreshSession"("userId", "lastSeenAt");

CREATE TABLE "PasswordReset" (
  "email" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("email")
);
CREATE INDEX "PasswordReset_expiresAt_idx" ON "PasswordReset"("expiresAt");

CREATE TABLE "AccountDeletionAudit" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "emailHash" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "scheduledFor" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountDeletionAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AccountDeletionAudit_userId_createdAt_idx" ON "AccountDeletionAudit"("userId", "createdAt");
CREATE INDEX "AccountDeletionAudit_createdAt_idx" ON "AccountDeletionAudit"("createdAt");
