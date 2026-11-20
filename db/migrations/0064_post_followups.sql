CREATE TABLE "post_followup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"question" text NOT NULL,
	"lang" text NOT NULL,
	"mention_ree_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"hidden_by" text,
	"report_count" integer DEFAULT 0 NOT NULL,
	"moderation_attempts" integer DEFAULT 0 NOT NULL,
	"answer_state" text DEFAULT 'waiting' NOT NULL,
	"candidates" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"client_token" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	CONSTRAINT "post_followup_status_check" CHECK (status in ('pending', 'published', 'rejected', 'hidden')),
	CONSTRAINT "post_followup_answer_state_check" CHECK (answer_state in ('waiting', 'answering', 'done')),
	CONSTRAINT "post_followup_hidden_by_check" CHECK (hidden_by is null or hidden_by in ('admin', 'reports')),
	CONSTRAINT "post_followup_lang_check" CHECK (lang in ('zh', 'en')),
	CONSTRAINT "post_followup_question_check" CHECK (char_length(question) between 1 and 2000),
	CONSTRAINT "post_followup_mentions_check" CHECK (cardinality(mention_ree_ids) <= 5),
	CONSTRAINT "post_followup_published_check" CHECK ((status = 'published') <= (published_at is not null))
);
--> statement-breakpoint
CREATE TABLE "post_followup_report" (
	"followup_id" uuid NOT NULL,
	"reporter_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_followup_report_followup_id_reporter_key_pk" PRIMARY KEY("followup_id","reporter_key")
);
--> statement-breakpoint
ALTER TABLE "notice" DROP CONSTRAINT "notice_kind_check";--> statement-breakpoint
DROP INDEX "post_answer_post_ree_key";--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "followup_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "post_answer" ADD COLUMN "followup_id" uuid;--> statement-breakpoint
ALTER TABLE "post_followup" ADD CONSTRAINT "post_followup_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_followup" ADD CONSTRAINT "post_followup_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_followup_report" ADD CONSTRAINT "post_followup_report_followup_id_post_followup_id_fk" FOREIGN KEY ("followup_id") REFERENCES "public"."post_followup"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_followup_thread_idx" ON "post_followup" USING btree ("post_id","created_at");--> statement-breakpoint
CREATE INDEX "post_followup_user_idx" ON "post_followup" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "post_followup_pending_idx" ON "post_followup" USING btree ("created_at") WHERE status = 'pending' or answer_state <> 'done';--> statement-breakpoint
CREATE UNIQUE INDEX "post_followup_client_token_key" ON "post_followup" USING btree ("user_id","client_token") WHERE client_token is not null;--> statement-breakpoint
ALTER TABLE "post_answer" ADD CONSTRAINT "post_answer_followup_id_post_followup_id_fk" FOREIGN KEY ("followup_id") REFERENCES "public"."post_followup"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "post_answer_followup_ree_key" ON "post_answer" USING btree ("followup_id","ree_id") WHERE followup_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "post_answer_post_ree_key" ON "post_answer" USING btree ("post_id","ree_id") WHERE followup_id is null;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_kind_check" CHECK (kind in ('takedown', 'restore', 'credits_adjust', 'kyc', 'payout', 'role', 'verification', 'post_answered', 'post_quoted', 'post_paid_requests', 'post_followup', 'followup_answered'));