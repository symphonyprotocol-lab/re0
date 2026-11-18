CREATE TABLE "ree_public_qa" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ree_id" uuid NOT NULL,
	"source" text NOT NULL,
	"user_id" uuid,
	"message_id" uuid,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lang" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"moderation_attempts" integer DEFAULT 0 NOT NULL,
	"hidden_by" text,
	"helpful_count" integer DEFAULT 0 NOT NULL,
	"report_count" integer DEFAULT 0 NOT NULL,
	"pinned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "ree_public_qa_source_check" CHECK (source in ('anonymous', 'user', 'share')),
	CONSTRAINT "ree_public_qa_status_check" CHECK (status in ('pending', 'published', 'hidden', 'rejected')),
	CONSTRAINT "ree_public_qa_hidden_by_check" CHECK (hidden_by is null or hidden_by in ('owner', 'admin', 'reports')),
	CONSTRAINT "ree_public_qa_lang_check" CHECK (lang in ('zh', 'en')),
	CONSTRAINT "ree_public_qa_question_check" CHECK (char_length(question) between 1 and 4000),
	CONSTRAINT "ree_public_qa_answer_check" CHECK (char_length(answer) between 1 and 20000),
	CONSTRAINT "ree_public_qa_published_check" CHECK ((status = 'published') <= (published_at is not null))
);
--> statement-breakpoint
CREATE TABLE "ree_public_qa_report" (
	"qa_id" uuid NOT NULL,
	"reporter_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ree_public_qa_report_qa_id_reporter_key_pk" PRIMARY KEY("qa_id","reporter_key")
);
--> statement-breakpoint
CREATE TABLE "ree_public_qa_vote" (
	"qa_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ree_public_qa_vote_qa_id_user_id_pk" PRIMARY KEY("qa_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "ree" ADD COLUMN "public_qa_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "ree_public_qa" ADD CONSTRAINT "ree_public_qa_ree_id_ree_id_fk" FOREIGN KEY ("ree_id") REFERENCES "public"."ree"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ree_public_qa" ADD CONSTRAINT "ree_public_qa_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ree_public_qa" ADD CONSTRAINT "ree_public_qa_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ree_public_qa_report" ADD CONSTRAINT "ree_public_qa_report_qa_id_ree_public_qa_id_fk" FOREIGN KEY ("qa_id") REFERENCES "public"."ree_public_qa"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ree_public_qa_vote" ADD CONSTRAINT "ree_public_qa_vote_qa_id_ree_public_qa_id_fk" FOREIGN KEY ("qa_id") REFERENCES "public"."ree_public_qa"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ree_public_qa_vote" ADD CONSTRAINT "ree_public_qa_vote_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ree_public_qa_feed_idx" ON "ree_public_qa" USING btree ("ree_id","published_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE status = 'published';--> statement-breakpoint
CREATE INDEX "ree_public_qa_pending_idx" ON "ree_public_qa" USING btree ("created_at") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "ree_public_qa_message_key" ON "ree_public_qa" USING btree ("message_id") WHERE message_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ree_public_qa_pinned_key" ON "ree_public_qa" USING btree ("ree_id") WHERE pinned_at is not null;--> statement-breakpoint
CREATE INDEX "ree_public_qa_user_idx" ON "ree_public_qa" USING btree ("user_id") WHERE user_id is not null;--> statement-breakpoint
CREATE INDEX "ree_public_qa_vote_user_idx" ON "ree_public_qa_vote" USING btree ("user_id");