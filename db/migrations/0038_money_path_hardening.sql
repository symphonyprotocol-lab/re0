ALTER TABLE "credit_entry" DROP CONSTRAINT "credit_entry_reason_check";--> statement-breakpoint
ALTER TABLE "credit_grant" ADD COLUMN "withdrawable_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_grant" ADD COLUMN "funding_purchase_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_hold" ADD COLUMN "ledger" text;--> statement-breakpoint
ALTER TABLE "credit_hold" ADD COLUMN "ree_id" uuid;--> statement-breakpoint
ALTER TABLE "paddle_checkout" ADD COLUMN "paddle_price_id" text;--> statement-breakpoint
ALTER TABLE "credit_grant" ADD CONSTRAINT "credit_grant_funding_purchase_id_purchase_id_fk" FOREIGN KEY ("funding_purchase_id") REFERENCES "public"."purchase"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "credit_grant_funding_idx" ON "credit_grant" USING btree ("funding_purchase_id") WHERE funding_purchase_id is not null;--> statement-breakpoint
CREATE INDEX "credit_hold_open_idx" ON "credit_hold" USING btree ("kind","created_at") WHERE status = 'held';--> statement-breakpoint
CREATE UNIQUE INDEX "payout_transfer_key" ON "payout" USING btree ("transfer_id") WHERE transfer_id is not null;--> statement-breakpoint
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_reason_check" CHECK (reason in ('welcome', 'knowledge_hold', 'knowledge_settle', 'knowledge_refund', 'query_hold', 'query_base', 'query_refund', 'query_fee_paid', 'query_fee_earned', 'purchase', 'refund', 'chargeback', 'debt_offset', 'expire', 'payout_hold', 'payout_release', 'payout_paid', 'video_script', 'video_export', 'admin_adjust', 'video_refund', 'verify_hold', 'verify_settle', 'verify_refund', 'synthesis_hold', 'synthesis_settle', 'synthesis_refund', 'storage_charge', 'redeem', 'chargeback_reverse', 'earned_void')) NOT VALID;--> statement-breakpoint
ALTER TABLE "credit_grant" ADD CONSTRAINT "credit_grant_withdrawable_check" CHECK (withdrawable_at is null or source = 'earned') NOT VALID;--> statement-breakpoint
UPDATE "credit_grant" SET "withdrawable_at" = "created_at" + interval '30 days' WHERE "source" = 'earned';--> statement-breakpoint
UPDATE "credit_hold" h SET "ledger" = CASE e."reason" WHEN 'query_fee_paid' THEN 'chat_fee' WHEN 'verify_hold' THEN 'chat_verify' WHEN 'synthesis_hold' THEN 'chat_synthesis' ELSE NULL END, "ree_id" = e."ree_id" FROM "credit_entry" e WHERE h."kind" = 'chat' AND h."status" = 'held' AND e."ref_id" = h."ref_id" AND e."created_at" = h."created_at" AND e."delta" = -h."amount" AND e."allocations" = h."allocations" AND e."reason" IN ('query_hold', 'query_fee_paid', 'verify_hold', 'synthesis_hold');--> statement-breakpoint
ALTER TABLE "credit_grant" VALIDATE CONSTRAINT "credit_grant_funding_purchase_id_purchase_id_fk";--> statement-breakpoint
ALTER TABLE "credit_entry" VALIDATE CONSTRAINT "credit_entry_reason_check";--> statement-breakpoint
ALTER TABLE "credit_grant" VALIDATE CONSTRAINT "credit_grant_withdrawable_check";
