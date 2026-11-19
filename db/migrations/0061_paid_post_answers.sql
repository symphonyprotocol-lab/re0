ALTER TABLE "notice" DROP CONSTRAINT "notice_kind_check";--> statement-breakpoint
ALTER TABLE "post_answer" DROP CONSTRAINT "post_answer_state_check";--> statement-breakpoint
ALTER TABLE "post_answer" ADD COLUMN "price" integer;--> statement-breakpoint
ALTER TABLE "post_answer" ADD COLUMN "base_hold_id" uuid;--> statement-breakpoint
ALTER TABLE "post_answer" ADD COLUMN "fee_hold_id" uuid;--> statement-breakpoint
ALTER TABLE "post_answer" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "post_answer_awaiting_idx" ON "post_answer" USING btree ("post_id") WHERE state in ('awaiting', 'answering');--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_kind_check" CHECK (kind in ('takedown', 'restore', 'credits_adjust', 'kyc', 'payout', 'role', 'verification', 'post_answered', 'post_quoted', 'post_paid_requests'));--> statement-breakpoint
ALTER TABLE "post_answer" ADD CONSTRAINT "post_answer_state_check" CHECK (state in ('queued', 'answering', 'answered', 'no_answer', 'failed', 'awaiting', 'declined'));