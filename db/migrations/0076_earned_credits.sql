CREATE TABLE "earned_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"convert_enabled" boolean NOT NULL,
	"convert_rate_bp" integer NOT NULL,
	"convert_min_credits" integer NOT NULL,
	"deduct_enabled" boolean NOT NULL,
	"deduct_credits_per_cent" integer NOT NULL,
	"deduct_max_percent" integer NOT NULL,
	"deduct_min_charge_minor" integer NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "earned_settings_singleton_check" CHECK (id = 1),
	CONSTRAINT "earned_settings_convert_check" CHECK (convert_rate_bp between 1 and 100000 and convert_min_credits between 1 and 100000000),
	CONSTRAINT "earned_settings_deduct_check" CHECK (deduct_credits_per_cent between 1 and 1000000 and deduct_max_percent between 1 and 100 and deduct_min_charge_minor between 70 and 100000)
);
--> statement-breakpoint
ALTER TABLE "credit_entry" DROP CONSTRAINT "credit_entry_reason_check";--> statement-breakpoint
ALTER TABLE "credit_grant" DROP CONSTRAINT "credit_grant_invite_funded_check";--> statement-breakpoint
ALTER TABLE "credit_hold" DROP CONSTRAINT "credit_hold_kind_check";--> statement-breakpoint
ALTER TABLE "purchase" ALTER COLUMN "paddle_transaction_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_grant" ADD COLUMN "converted_paid" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_grant" ADD COLUMN "converted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_grant" ADD COLUMN "void_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paddle_checkout" ADD COLUMN "earned_hold_id" uuid;--> statement-breakpoint
ALTER TABLE "paddle_checkout" ADD COLUMN "earned_credits" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "paddle_checkout" ADD COLUMN "earned_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase" ADD COLUMN "earned_credits" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase" ADD COLUMN "earned_minor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase" ADD COLUMN "earned_hold_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase" ADD COLUMN "earned_returned" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "earned_settings" ADD CONSTRAINT "earned_settings_updated_by_administrator_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."administrator"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paddle_checkout_earned_idx" ON "paddle_checkout" USING btree ("created_at") WHERE earned_hold_id is not null and superseded_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_request_key" ON "purchase" USING btree ("user_id","request_id") WHERE request_id is not null;--> statement-breakpoint
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_reason_check" CHECK (reason in ('welcome', 'knowledge_hold', 'knowledge_settle', 'knowledge_refund', 'query_hold', 'query_base', 'query_refund', 'query_fee_paid', 'query_fee_earned', 'purchase', 'refund', 'chargeback', 'debt_offset', 'expire', 'payout_hold', 'payout_release', 'payout_paid', 'video_script', 'video_export', 'admin_adjust', 'video_refund', 'verify_hold', 'verify_settle', 'verify_refund', 'synthesis_hold', 'synthesis_settle', 'synthesis_refund', 'storage_charge', 'redeem', 'chargeback_reverse', 'earned_void', 'earned_restore', 'invite_reward', 'invite_reward_gift', 'task_first_ree', 'task_first_question', 'task_first_comment', 'check_in', 'post_hold', 'post_settle', 'post_refund', 'ai_answer_hold', 'ai_answer_settle', 'ai_answer_refund', 'earned_convert', 'earned_converted', 'deduction_hold', 'deduction_paid', 'deduction_release', 'deduction_return'));--> statement-breakpoint
ALTER TABLE "credit_grant" ADD CONSTRAINT "credit_grant_converted_check" CHECK ((not converted or source = 'pack') and (not converted_paid or converted) and (void_until is null or converted_paid));--> statement-breakpoint
ALTER TABLE "credit_grant" ADD CONSTRAINT "credit_grant_invite_funded_check" CHECK (not invite_funded or (source = 'earned' and withdrawable_at is not null) or (source = 'pack' and converted_paid));--> statement-breakpoint
ALTER TABLE "credit_hold" ADD CONSTRAINT "credit_hold_kind_check" CHECK (kind in ('chat', 'knowledge', 'video', 'payout', 'post', 'deduction'));--> statement-breakpoint
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_paid_check" CHECK (paddle_transaction_id is not null or earned_minor > 0);--> statement-breakpoint
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_earned_check" CHECK (earned_credits >= 0 and earned_minor >= 0 and earned_returned between 0 and earned_credits);