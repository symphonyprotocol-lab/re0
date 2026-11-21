CREATE TABLE "post" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"source" text NOT NULL,
	"legacy_qa_id" uuid,
	"message_id" uuid,
	"anonymous" boolean DEFAULT false NOT NULL,
	"question" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"lang" text NOT NULL,
	"category" text,
	"mention_ree_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"hidden_by" text,
	"moderation_attempts" integer DEFAULT 0 NOT NULL,
	"answer_state" text DEFAULT 'waiting' NOT NULL,
	"candidates" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"answer_count" integer DEFAULT 0 NOT NULL,
	"charge" text DEFAULT 'none' NOT NULL,
	"hold_id" uuid,
	"free_day" date,
	"summary_state" text,
	"summary_content" text,
	"summary_sources" jsonb,
	"summary_hold_id" uuid,
	"summary_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	CONSTRAINT "post_source_check" CHECK (source in ('post', 'anonymous', 'share', 'conversation', 'seed')),
	CONSTRAINT "post_status_check" CHECK (status in ('pending', 'published', 'rejected', 'hidden')),
	CONSTRAINT "post_answer_state_check" CHECK (answer_state in ('waiting', 'answering', 'done')),
	CONSTRAINT "post_charge_check" CHECK (charge in ('free', 'paid', 'none')),
	CONSTRAINT "post_hidden_by_check" CHECK (hidden_by is null or hidden_by = 'admin'),
	CONSTRAINT "post_summary_state_check" CHECK (summary_state is null or summary_state in ('running', 'done')),
	CONSTRAINT "post_lang_check" CHECK (lang in ('zh', 'en')),
	CONSTRAINT "post_question_check" CHECK (char_length(question) between 1 and 4000),
	CONSTRAINT "post_detail_check" CHECK (char_length(detail) <= 2000),
	CONSTRAINT "post_published_check" CHECK ((status = 'published') <= (published_at is not null))
);
--> statement-breakpoint
CREATE TABLE "post_answer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"ree_id" uuid NOT NULL,
	"legacy_qa_id" uuid,
	"similarity" real,
	"mentioned" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text,
	"hidden_by" text,
	"helpful_count" integer DEFAULT 0 NOT NULL,
	"report_count" integer DEFAULT 0 NOT NULL,
	"pinned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	CONSTRAINT "post_answer_state_check" CHECK (state in ('queued', 'answering', 'answered', 'no_answer', 'failed')),
	CONSTRAINT "post_answer_hidden_by_check" CHECK (hidden_by is null or hidden_by in ('owner', 'admin', 'reports')),
	CONSTRAINT "post_answer_text_check" CHECK (char_length(text) <= 20000)
);
--> statement-breakpoint
CREATE TABLE "post_answer_report" (
	"answer_id" uuid NOT NULL,
	"reporter_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_answer_report_answer_id_reporter_key_pk" PRIMARY KEY("answer_id","reporter_key")
);
--> statement-breakpoint
CREATE TABLE "post_answer_vote" (
	"answer_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_answer_vote_answer_id_user_id_pk" PRIMARY KEY("answer_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "post_save" (
	"user_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_save_user_id_post_id_pk" PRIMARY KEY("user_id","post_id")
);
--> statement-breakpoint
ALTER TABLE "credit_entry" DROP CONSTRAINT "credit_entry_reason_check";--> statement-breakpoint
ALTER TABLE "credit_hold" DROP CONSTRAINT "credit_hold_kind_check";--> statement-breakpoint
ALTER TABLE "notice" DROP CONSTRAINT "notice_kind_check";--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "post_id" uuid;--> statement-breakpoint
ALTER TABLE "ree" ADD COLUMN "answers_posts" boolean;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_legacy_qa_id_ree_public_qa_id_fk" FOREIGN KEY ("legacy_qa_id") REFERENCES "public"."ree_public_qa"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_mention_ree_id_ree_id_fk" FOREIGN KEY ("mention_ree_id") REFERENCES "public"."ree"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_answer" ADD CONSTRAINT "post_answer_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_answer" ADD CONSTRAINT "post_answer_ree_id_ree_id_fk" FOREIGN KEY ("ree_id") REFERENCES "public"."ree"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_answer" ADD CONSTRAINT "post_answer_legacy_qa_id_ree_public_qa_id_fk" FOREIGN KEY ("legacy_qa_id") REFERENCES "public"."ree_public_qa"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_answer_report" ADD CONSTRAINT "post_answer_report_answer_id_post_answer_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."post_answer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_answer_vote" ADD CONSTRAINT "post_answer_vote_answer_id_post_answer_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."post_answer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_answer_vote" ADD CONSTRAINT "post_answer_vote_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_save" ADD CONSTRAINT "post_save_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_save" ADD CONSTRAINT "post_save_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_feed_idx" ON "post" USING btree ("published_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE status = 'published' and deleted_at is null;--> statement-breakpoint
CREATE INDEX "post_user_idx" ON "post" USING btree ("user_id","created_at" DESC NULLS LAST) WHERE user_id is not null;--> statement-breakpoint
CREATE INDEX "post_free_day_idx" ON "post" USING btree ("user_id","free_day") WHERE free_day is not null;--> statement-breakpoint
CREATE INDEX "post_pending_idx" ON "post" USING btree ("created_at") WHERE status = 'pending' or answer_state <> 'done';--> statement-breakpoint
CREATE UNIQUE INDEX "post_legacy_qa_key" ON "post" USING btree ("legacy_qa_id") WHERE legacy_qa_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "post_answer_post_ree_key" ON "post_answer" USING btree ("post_id","ree_id");--> statement-breakpoint
CREATE INDEX "post_answer_ree_idx" ON "post_answer" USING btree ("ree_id","answered_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE state = 'answered' and hidden_by is null;--> statement-breakpoint
CREATE UNIQUE INDEX "post_answer_legacy_qa_key" ON "post_answer" USING btree ("legacy_qa_id") WHERE legacy_qa_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "post_answer_pinned_key" ON "post_answer" USING btree ("ree_id") WHERE pinned_at is not null;--> statement-breakpoint
CREATE INDEX "post_answer_vote_user_idx" ON "post_answer_vote" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "post_save_recent_idx" ON "post_save" USING btree ("user_id","created_at" DESC NULLS LAST,"post_id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_post_idx" ON "conversation" USING btree ("post_id") WHERE post_id is not null;--> statement-breakpoint
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_reason_check" CHECK (reason in ('welcome', 'knowledge_hold', 'knowledge_settle', 'knowledge_refund', 'query_hold', 'query_base', 'query_refund', 'query_fee_paid', 'query_fee_earned', 'purchase', 'refund', 'chargeback', 'debt_offset', 'expire', 'payout_hold', 'payout_release', 'payout_paid', 'video_script', 'video_export', 'admin_adjust', 'video_refund', 'verify_hold', 'verify_settle', 'verify_refund', 'synthesis_hold', 'synthesis_settle', 'synthesis_refund', 'storage_charge', 'redeem', 'chargeback_reverse', 'earned_void', 'earned_restore', 'invite_reward', 'invite_reward_gift', 'task_first_ree', 'task_first_question', 'task_first_comment', 'check_in', 'post_hold', 'post_settle', 'post_refund'));--> statement-breakpoint
ALTER TABLE "credit_hold" ADD CONSTRAINT "credit_hold_kind_check" CHECK (kind in ('chat', 'knowledge', 'video', 'payout', 'post'));--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_kind_check" CHECK (kind in ('takedown', 'restore', 'credits_adjust', 'kyc', 'payout', 'role', 'verification', 'post_answered'));--> statement-breakpoint
-- #158's public Q&A as posts (lib/services/public-qa-sync.ts, the same statements; safe to run again).
insert into post (user_id, source, legacy_qa_id, message_id, anonymous, question, lang, category, status, answer_state, answer_count, charge, created_at, published_at, answered_at)
select q.user_id, case q.source when 'user' then 'conversation' else q.source end, q.id, q.message_id, true, left(q.question, 4000), q.lang, r.category,
  'published', 'done', case when q.status = 'published' then 1 else 0 end, 'none', q.created_at, coalesce(q.published_at, q.created_at), coalesce(q.published_at, q.created_at)
from ree_public_qa q join ree r on r.id = q.ree_id
where q.status in ('published', 'hidden') and not exists (select 1 from post p where p.legacy_qa_id = q.id)
on conflict (legacy_qa_id) where legacy_qa_id is not null do nothing;--> statement-breakpoint
insert into post_answer (post_id, ree_id, legacy_qa_id, state, text, citations, hidden_by, helpful_count, report_count, pinned_at, created_at, answered_at)
select p.id, q.ree_id, q.id, 'answered', q.answer, q.citations, case when q.status = 'hidden' then coalesce(q.hidden_by, 'admin') end, q.helpful_count, q.report_count,
  case when q.status = 'published' and not exists (select 1 from post_answer pa where pa.ree_id = q.ree_id and pa.pinned_at is not null) then q.pinned_at end,
  q.created_at, coalesce(q.published_at, q.created_at)
from ree_public_qa q join post p on p.legacy_qa_id = q.id
where not exists (select 1 from post_answer a where a.legacy_qa_id = q.id)
on conflict do nothing;--> statement-breakpoint
insert into post_answer_vote (answer_id, user_id, created_at)
select a.id, v.user_id, v.created_at from ree_public_qa_vote v join post_answer a on a.legacy_qa_id = v.qa_id
on conflict do nothing;--> statement-breakpoint
insert into post_answer_report (answer_id, reporter_key, created_at)
select a.id, r.reporter_key, r.created_at from ree_public_qa_report r join post_answer a on a.legacy_qa_id = r.qa_id
on conflict do nothing;
