-- Paddle becomes the Payment Provider. architecture.md 11.3.
--
-- Five changes, each the database half of an idempotency or ordering rule
-- checkout or the webhook relies on:
--
-- 1. `subscription.observed_at` -- the instant the provider says the row's
--    state was true. Webhooks are not ordered, so a `subscription.updated`
--    describing an older state can land after a newer one; the projection
--    only overwrites a row whose state is older than the event's. Null on
--    every row the provider never wrote (the Free subscription signup
--    creates), which any event is allowed to supersede.
--
-- 2. `subscription.provider_subscription_id` is unique. One provider
--    subscription is one row moving through states, not a row per
--    notification -- and the upsert needs the constraint to conflict on.
--    Postgres treats nulls as distinct, so the provider-less Free rows are
--    unaffected.
--
-- 3. `addon_grant.provider_order_id` is unique. A pack's transaction reports
--    `paid` and then `completed`, and either may be redelivered; the grant is
--    written once per order no matter which of them arrives first or how
--    often, because a duplicated grant is calls nobody paid for.

ALTER TABLE "subscription" ADD COLUMN "observed_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_provider_uq" ON "subscription" ("provider_subscription_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "addon_grant_provider_order_uq" ON "addon_grant" ("provider_order_id");
--> statement-breakpoint
-- 4. `paused` becomes a subscription state. Paddle can pause a subscription,
--    and folding that into `canceled` would let checkout sell a second one
--    beside it that both charge once the first resumes.
ALTER TYPE "subscription_status" ADD VALUE IF NOT EXISTS 'paused';
--> statement-breakpoint
-- 5. `payment_checkout` -- the checkouts this server has opened at the
--    provider. A paid checkout only becomes a subscription row when its
--    webhook lands, so in the seconds between, "does this workspace already
--    subscribe?" cannot be answered from `subscription` alone; checkout asks
--    the provider about these instead, and reuses one still open rather than
--    opening a second the buyer could also pay.
CREATE TABLE "payment_checkout" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id"),
  "provider" text NOT NULL,
  "external_id" text NOT NULL,
  "kind" "billing_document_kind" NOT NULL,
  "plan_version_id" uuid NOT NULL REFERENCES "plan_version"("id"),
  "checkout_url" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_checkout_uq" ON "payment_checkout" ("provider", "external_id");
--> statement-breakpoint
CREATE INDEX "payment_checkout_workspace_idx" ON "payment_checkout" ("workspace_id", "created_at" DESC);
