-- TaskFlow never exposed "doing" or "snoozed" as durable UI states.
-- Preserve those tasks by returning them to the active queue before tightening
-- the application-level status contract.
UPDATE "Task"
SET "status" = 'todo', "updatedAt" = NOW()
WHERE "status" IN ('doing', 'snoozed');
