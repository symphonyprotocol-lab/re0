DROP INDEX "redeem_redemption_plan_due_idx";--> statement-breakpoint
ALTER TABLE "redeem_redemption" ADD COLUMN "next_period_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "redeem_redemption_next_period_idx" ON "redeem_redemption" USING btree ("next_period_at") WHERE next_period_at is not null and revoked_at is null;--> statement-breakpoint
UPDATE "redeem_redemption" SET "next_period_at" = "plan_starts_at" WHERE kind = 'plan' AND revoked_at IS NULL AND plan_ends_at > now();
