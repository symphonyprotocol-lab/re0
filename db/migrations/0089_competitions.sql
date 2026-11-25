CREATE TABLE "competition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"channel_id" uuid,
	"host_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"lang" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"question_mode" text DEFAULT 'open' NOT NULL,
	"payer" text DEFAULT 'entrant' NOT NULL,
	"max_entries" integer NOT NULL,
	"max_entries_per_user" integer DEFAULT 1 NOT NULL,
	"weights" jsonb NOT NULL,
	"reveal_reference" boolean DEFAULT true NOT NULL,
	"deadline_at" timestamp with time zone,
	"review_hours" integer DEFAULT 72 NOT NULL,
	"review_ends_at" timestamp with time zone,
	"answer_fee" integer,
	"judge_fee" integer,
	"answer_model" text,
	"judge_model" text,
	"deposit_hold_id" uuid,
	"judge_hold_id" uuid,
	"moderation_attempts" integer DEFAULT 0 NOT NULL,
	"rejected_reason" text,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"hidden_by" text,
	"report_count" integer DEFAULT 0 NOT NULL,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "competition_status_check" CHECK (status in ('draft', 'pending', 'open', 'answering', 'judging', 'review', 'published', 'rejected', 'cancelled')),
	CONSTRAINT "competition_question_mode_check" CHECK (question_mode in ('open', 'closed')),
	CONSTRAINT "competition_payer_check" CHECK (payer in ('entrant', 'host')),
	CONSTRAINT "competition_lang_check" CHECK (lang in ('zh', 'en')),
	CONSTRAINT "competition_title_check" CHECK (char_length(title) between 1 and 80),
	CONSTRAINT "competition_description_check" CHECK (char_length(description) <= 8000),
	CONSTRAINT "competition_max_entries_check" CHECK (max_entries between 1 and 100),
	CONSTRAINT "competition_max_entries_per_user_check" CHECK (max_entries_per_user between 1 and 3),
	CONSTRAINT "competition_review_hours_check" CHECK (review_hours between 0 and 168),
	CONSTRAINT "competition_hidden_by_check" CHECK (hidden_by is null or hidden_by = 'admin')
);
--> statement-breakpoint
CREATE TABLE "competition_answer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competition_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"ree_id" uuid NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"text" text DEFAULT '' NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"judge_state" text,
	"judge_attempts" integer DEFAULT 0 NOT NULL,
	"judge_started_at" timestamp with time zone,
	"ai_scores" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_score" real,
	"rationale" text,
	"injection" boolean DEFAULT false NOT NULL,
	"host_score" real,
	"final_score" real,
	"review" text,
	"review_attempts" integer DEFAULT 0 NOT NULL,
	"post_answer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competition_answer_state_check" CHECK (state in ('queued', 'answering', 'answered', 'no_answer', 'failed')),
	CONSTRAINT "competition_answer_judge_state_check" CHECK (judge_state is null or judge_state in ('pending', 'running', 'done', 'failed')),
	CONSTRAINT "competition_answer_review_check" CHECK (review is null or review in ('pending', 'passed', 'rejected')),
	CONSTRAINT "competition_answer_text_check" CHECK (char_length(text) <= 20000),
	CONSTRAINT "competition_answer_host_score_check" CHECK (host_score is null or host_score between 0 and 10)
);
--> statement-breakpoint
CREATE TABLE "competition_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competition_id" uuid NOT NULL,
	"ree_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'entered' NOT NULL,
	"locked_at" timestamp with time zone,
	"system_prompt" text,
	"payer_id" uuid,
	"hold_id" uuid,
	"answered" integer DEFAULT 0 NOT NULL,
	"total_score" real,
	"rank" integer,
	"reminded_at" timestamp with time zone,
	"disqualified_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "competition_entry_status_check" CHECK (status in ('entered', 'withdrawn', 'locked', 'skipped_balance', 'disqualified'))
);
--> statement-breakpoint
CREATE TABLE "competition_question" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competition_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"question" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"reference_answer" text NOT NULL,
	"rubric" text DEFAULT '' NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"post_id" uuid,
	"embedding" jsonb,
	CONSTRAINT "competition_question_ordinal_check" CHECK (ordinal between 1 and 20),
	CONSTRAINT "competition_question_question_check" CHECK (char_length(question) between 1 and 300),
	CONSTRAINT "competition_question_detail_check" CHECK (char_length(detail) <= 2000),
	CONSTRAINT "competition_question_reference_check" CHECK (char_length(reference_answer) between 1 and 4000),
	CONSTRAINT "competition_question_rubric_check" CHECK (char_length(rubric) <= 2000),
	CONSTRAINT "competition_question_weight_check" CHECK (weight between 0.1 and 10)
);
--> statement-breakpoint
CREATE TABLE "competition_report" (
	"competition_id" uuid NOT NULL,
	"reporter_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competition_report_competition_id_reporter_key_pk" PRIMARY KEY("competition_id","reporter_key")
);
--> statement-breakpoint
CREATE TABLE "competition_score_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"answer_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"actor_id" uuid,
	"from_score" real,
	"to_score" real NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competition_score_log_actor_check" CHECK (actor in ('host', 'admin')),
	CONSTRAINT "competition_score_log_note_check" CHECK (char_length(note) between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "credit_entry" DROP CONSTRAINT "credit_entry_reason_check";--> statement-breakpoint
ALTER TABLE "credit_hold" DROP CONSTRAINT "credit_hold_kind_check";--> statement-breakpoint
ALTER TABLE "notice" DROP CONSTRAINT "notice_kind_check";--> statement-breakpoint
ALTER TABLE "post" DROP CONSTRAINT "post_source_check";--> statement-breakpoint
ALTER TABLE "competition" ADD CONSTRAINT "competition_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition" ADD CONSTRAINT "competition_host_id_user_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_answer" ADD CONSTRAINT "competition_answer_competition_id_competition_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_answer" ADD CONSTRAINT "competition_answer_entry_id_competition_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."competition_entry"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_answer" ADD CONSTRAINT "competition_answer_question_id_competition_question_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."competition_question"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_answer" ADD CONSTRAINT "competition_answer_ree_id_ree_id_fk" FOREIGN KEY ("ree_id") REFERENCES "public"."ree"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_answer" ADD CONSTRAINT "competition_answer_post_answer_id_post_answer_id_fk" FOREIGN KEY ("post_answer_id") REFERENCES "public"."post_answer"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_entry" ADD CONSTRAINT "competition_entry_competition_id_competition_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_entry" ADD CONSTRAINT "competition_entry_ree_id_ree_id_fk" FOREIGN KEY ("ree_id") REFERENCES "public"."ree"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_entry" ADD CONSTRAINT "competition_entry_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_question" ADD CONSTRAINT "competition_question_competition_id_competition_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_question" ADD CONSTRAINT "competition_question_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_report" ADD CONSTRAINT "competition_report_competition_id_competition_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_score_log" ADD CONSTRAINT "competition_score_log_answer_id_competition_answer_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."competition_answer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "competition_slug_key" ON "competition" USING btree ("slug") WHERE status not in ('cancelled', 'rejected');--> statement-breakpoint
CREATE UNIQUE INDEX "competition_channel_key" ON "competition" USING btree ("channel_id") WHERE channel_id is not null;--> statement-breakpoint
CREATE INDEX "competition_status_idx" ON "competition" USING btree ("status","deadline_at");--> statement-breakpoint
CREATE INDEX "competition_host_idx" ON "competition" USING btree ("host_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "competition_published_idx" ON "competition" USING btree ("published_at" DESC NULLS LAST) WHERE status = 'published' and hidden_by is null;--> statement-breakpoint
CREATE UNIQUE INDEX "competition_answer_key" ON "competition_answer" USING btree ("entry_id","question_id");--> statement-breakpoint
CREATE INDEX "competition_answer_run_idx" ON "competition_answer" USING btree ("state","next_attempt_at") WHERE state in ('queued', 'answering');--> statement-breakpoint
CREATE INDEX "competition_answer_judge_idx" ON "competition_answer" USING btree ("judge_state") WHERE judge_state in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "competition_answer_review_idx" ON "competition_answer" USING btree ("review") WHERE review = 'pending';--> statement-breakpoint
CREATE INDEX "competition_answer_question_idx" ON "competition_answer" USING btree ("question_id","final_score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "competition_answer_competition_idx" ON "competition_answer" USING btree ("competition_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "competition_entry_ree_key" ON "competition_entry" USING btree ("competition_id","ree_id");--> statement-breakpoint
CREATE INDEX "competition_entry_status_idx" ON "competition_entry" USING btree ("competition_id","status");--> statement-breakpoint
CREATE INDEX "competition_entry_user_idx" ON "competition_entry" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "competition_entry_rank_idx" ON "competition_entry" USING btree ("competition_id","rank") WHERE rank is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "competition_question_ordinal_key" ON "competition_question" USING btree ("competition_id","ordinal");--> statement-breakpoint
CREATE INDEX "competition_question_post_idx" ON "competition_question" USING btree ("post_id") WHERE post_id is not null;--> statement-breakpoint
CREATE INDEX "competition_score_log_answer_idx" ON "competition_score_log" USING btree ("answer_id","created_at");--> statement-breakpoint
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_reason_check" CHECK (reason in ('welcome', 'knowledge_hold', 'knowledge_settle', 'knowledge_refund', 'query_hold', 'query_base', 'query_refund', 'query_fee_paid', 'query_fee_earned', 'purchase', 'refund', 'chargeback', 'debt_offset', 'expire', 'payout_hold', 'payout_release', 'payout_paid', 'video_script', 'video_export', 'admin_adjust', 'video_refund', 'verify_hold', 'verify_settle', 'verify_refund', 'synthesis_hold', 'synthesis_settle', 'synthesis_refund', 'storage_charge', 'redeem', 'chargeback_reverse', 'earned_void', 'earned_restore', 'invite_reward', 'invite_reward_gift', 'task_first_ree', 'task_first_question', 'task_first_comment', 'task_first_post', 'task_first_helpful', 'check_in', 'post_hold', 'post_settle', 'post_refund', 'ai_answer_hold', 'ai_answer_settle', 'ai_answer_refund', 'earned_convert', 'earned_converted', 'deduction_hold', 'deduction_paid', 'deduction_release', 'deduction_return', 'competition_deposit_hold', 'competition_deposit_settle', 'competition_deposit_release', 'judge_hold', 'judge_settle', 'judge_refund'));--> statement-breakpoint
ALTER TABLE "credit_hold" ADD CONSTRAINT "credit_hold_kind_check" CHECK (kind in ('chat', 'knowledge', 'video', 'payout', 'post', 'deduction', 'competition'));--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_kind_check" CHECK (kind in ('takedown', 'restore', 'credits_adjust', 'kyc', 'payout', 'role', 'verification', 'post_answered', 'post_quoted', 'post_paid_requests', 'post_followup', 'followup_answered', 'chats_removal', 'post_ai_answer', 'visitor_ask_paused', 'competition_published', 'competition_balance_short', 'competition_review_ready', 'competition_results'));--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_source_check" CHECK (source in ('post', 'anonymous', 'share', 'conversation', 'seed', 'test', 'api', 'visitor', 'competition'));