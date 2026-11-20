CREATE TABLE "post_ai_answer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"followup_id" uuid,
	"user_id" uuid NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"model" text,
	"hold_id" uuid,
	"price" integer DEFAULT 0 NOT NULL,
	"vote" text,
	"started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	CONSTRAINT "post_ai_answer_state_check" CHECK (state in ('running', 'answered', 'failed', 'skipped_balance')),
	CONSTRAINT "post_ai_answer_vote_check" CHECK (vote is null or vote in ('helpful', 'unhelpful')),
	CONSTRAINT "post_ai_answer_text_check" CHECK (char_length(text) <= 20000)
);
--> statement-breakpoint
ALTER TABLE "credit_entry" DROP CONSTRAINT "credit_entry_reason_check";--> statement-breakpoint
ALTER TABLE "notice" DROP CONSTRAINT "notice_kind_check";--> statement-breakpoint
ALTER TABLE "post_ai_answer" ADD CONSTRAINT "post_ai_answer_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_ai_answer" ADD CONSTRAINT "post_ai_answer_followup_id_post_followup_id_fk" FOREIGN KEY ("followup_id") REFERENCES "public"."post_followup"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_ai_answer" ADD CONSTRAINT "post_ai_answer_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "post_ai_answer_post_key" ON "post_ai_answer" USING btree ("post_id") WHERE followup_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX "post_ai_answer_followup_key" ON "post_ai_answer" USING btree ("followup_id") WHERE followup_id is not null;--> statement-breakpoint
CREATE INDEX "post_ai_answer_running_idx" ON "post_ai_answer" USING btree ("started_at") WHERE state = 'running';--> statement-breakpoint
CREATE INDEX "post_ai_answer_user_idx" ON "post_ai_answer" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_reason_check" CHECK (reason in ('welcome', 'knowledge_hold', 'knowledge_settle', 'knowledge_refund', 'query_hold', 'query_base', 'query_refund', 'query_fee_paid', 'query_fee_earned', 'purchase', 'refund', 'chargeback', 'debt_offset', 'expire', 'payout_hold', 'payout_release', 'payout_paid', 'video_script', 'video_export', 'admin_adjust', 'video_refund', 'verify_hold', 'verify_settle', 'verify_refund', 'synthesis_hold', 'synthesis_settle', 'synthesis_refund', 'storage_charge', 'redeem', 'chargeback_reverse', 'earned_void', 'earned_restore', 'invite_reward', 'invite_reward_gift', 'task_first_ree', 'task_first_question', 'task_first_comment', 'check_in', 'post_hold', 'post_settle', 'post_refund', 'ai_answer_hold', 'ai_answer_settle', 'ai_answer_refund'));--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_kind_check" CHECK (kind in ('takedown', 'restore', 'credits_adjust', 'kyc', 'payout', 'role', 'verification', 'post_answered', 'post_quoted', 'post_paid_requests', 'post_followup', 'followup_answered', 'chats_removal', 'post_ai_answer'));