-- Re-issuing an enrolment link rotates this nonce, so earlier links stop working.
-- Null on rows from before it: their outstanding link keeps working until re-issued.
ALTER TABLE "administrator" ADD COLUMN IF NOT EXISTS "invite_nonce" text;
