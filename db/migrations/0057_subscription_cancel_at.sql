-- A cancellation scheduled for the end of the period (2026-10-24). Paddle
-- keeps such a subscription `active` until it takes effect and says so only
-- in `scheduled_change`; the column holds its `effective_at`, so the settings
-- page and the console can tell "renews on" from "cancels on".
-- lib/infrastructure/payment/paddle.ts (`subscriptionNotice`).
--
-- Existing rows start null, which reads as "renews". The next
-- `subscription.updated` for a subscription already set to cancel fills it in.

ALTER TABLE "subscription" ADD COLUMN IF NOT EXISTS "cancel_at" timestamp with time zone;
