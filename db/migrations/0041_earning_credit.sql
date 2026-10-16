-- Earnings redeemed as Additional Calls. publisher-revenue-share.md 3.4.
--
-- The collection provider (Paddle) sells to our customers and settles to us;
-- it has no way to pay a third party, so the first discharge path for a
-- publisher's statements is not money at all: the settled amount becomes an
-- `addon_grant`, priced at the current Additional Calls version, and the calls
-- are spent like any bought pack. The platform still holds no funds -- a grant
-- is an entitlement on our own service, not a balance -- and nothing here
-- touches `payout`, which stays reserved for the external payout service of
-- stage 3.
--
-- Three things make that traceable in both directions: a statement status
-- that is not `paid` (cash never left), the publisher the grant was redeemed
-- for, and on each statement the grant it became.

ALTER TYPE "settlement_status" ADD VALUE IF NOT EXISTS 'redeemed' AFTER 'paid';
--> statement-breakpoint
ALTER TABLE "addon_grant"
  ADD COLUMN IF NOT EXISTS "publisher_account_id" uuid REFERENCES "publisher_account"("id");
--> statement-breakpoint
-- Who redeemed it: `user:<id>` from the dashboard, `api_key:<id>` from the API.
-- A redemption spends value; a workspace with several admins must be able to
-- say which of them did it.
ALTER TABLE "addon_grant"
  ADD COLUMN IF NOT EXISTS "redeemed_by" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "addon_grant_publisher_idx"
  ON "addon_grant" ("publisher_account_id", "created_at" DESC);
--> statement-breakpoint
ALTER TABLE "settlement"
  ADD COLUMN IF NOT EXISTS "addon_grant_id" uuid REFERENCES "addon_grant"("id");
