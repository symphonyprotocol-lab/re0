-- Cash payout by hand. publisher-revenue-share.md 3.4 (2026-10-26).
--
-- No payout service is connected yet, so cash leaves the books manually: the
-- publisher requests a payout of everything past its hold (at least the $20
-- threshold) to a PayPal address, the statements it covers move to `held`,
-- an operator sends the money from the platform's PayPal account and marks
-- the payout `paid` with the PayPal transaction id -- or `failed` with a
-- reason, which returns the statements to `accrued`.
--
-- The payee is a PayPal email and nothing else: no card or bank numbers are
-- collected, so the "no bank details on our side" rule still holds.

ALTER TABLE "payout" ADD COLUMN IF NOT EXISTS "method" text DEFAULT 'paypal' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payout" ADD COLUMN IF NOT EXISTS "payee_email" text;
--> statement-breakpoint
ALTER TABLE "payout" ADD COLUMN IF NOT EXISTS "requested_by" text;
--> statement-breakpoint
ALTER TABLE "payout"
  ADD COLUMN IF NOT EXISTS "resolved_by" uuid REFERENCES "administrator"("id");
--> statement-breakpoint
ALTER TABLE "payout" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;
--> statement-breakpoint
-- One open request per publisher: two racing requests cannot both hold statements.
CREATE UNIQUE INDEX IF NOT EXISTS "payout_open_uq"
  ON "payout" ("publisher_account_id") WHERE "status" = 'requested';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payout_status_time_idx" ON "payout" ("status", "created_at");
--> statement-breakpoint
ALTER TABLE "settlement"
  ADD COLUMN IF NOT EXISTS "payout_id" uuid REFERENCES "payout"("id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "settlement_payout_idx" ON "settlement" ("payout_id");
