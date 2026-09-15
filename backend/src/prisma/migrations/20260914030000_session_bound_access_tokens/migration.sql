ALTER TABLE "User"
ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "User"
ADD CONSTRAINT "User_authVersion_positive" CHECK ("authVersion" > 0);
