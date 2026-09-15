ALTER TABLE "Device"
  ADD COLUMN "lastAcknowledgedCursor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "requiresBootstrap" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Device"
  ADD CONSTRAINT "Device_lastAcknowledgedCursor_nonnegative" CHECK ("lastAcknowledgedCursor" >= 0);

CREATE INDEX "Device_userId_lastAcknowledgedCursor_idx"
ON "Device"("userId", "lastAcknowledgedCursor");
