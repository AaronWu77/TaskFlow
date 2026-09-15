ALTER TABLE "RefreshSession"
ADD COLUMN "reuseGraceUntil" TIMESTAMP(3);

CREATE INDEX "RefreshSession_reuseGraceUntil_idx" ON "RefreshSession"("reuseGraceUntil");
