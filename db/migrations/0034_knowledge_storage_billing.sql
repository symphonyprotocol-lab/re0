CREATE TABLE "storage_accrual" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"cost_pico" numeric(40, 0) DEFAULT '0' NOT NULL,
	"charged_credits" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_entry" DROP CONSTRAINT "credit_entry_reason_check";--> statement-breakpoint
ALTER TABLE "knowledge" ADD COLUMN "storage_billed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "storage_accrual" ADD CONSTRAINT "storage_accrual_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_reason_check" CHECK (reason in ('welcome', 'knowledge_hold', 'knowledge_settle', 'knowledge_refund', 'query_hold', 'query_base', 'query_refund', 'query_fee_paid', 'query_fee_earned', 'purchase', 'refund', 'chargeback', 'debt_offset', 'expire', 'payout_hold', 'payout_release', 'payout_paid', 'video_script', 'video_export', 'admin_adjust', 'video_refund', 'verify_hold', 'verify_settle', 'verify_refund', 'synthesis_hold', 'synthesis_settle', 'synthesis_refund', 'storage_charge'));