CREATE TABLE "rate_bucket" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_bucket_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "ree_feedback" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"vote" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ree_feedback_message_id_user_id_pk" PRIMARY KEY("message_id","user_id"),
	CONSTRAINT "ree_feedback_vote_check" CHECK (vote in ('up', 'down'))
);
--> statement-breakpoint
CREATE TABLE "ree_profile_vector" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ree_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ree_profile_vector_kind_check" CHECK (kind in ('profile', 'sample_question', 'centroid'))
);
--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "suggested_ree_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ree" ADD COLUMN "moderated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ree" ADD COLUMN "moderated_by" uuid;--> statement-breakpoint
ALTER TABLE "ree" ADD COLUMN "moderated_reason" text;--> statement-breakpoint
ALTER TABLE "ree" ADD COLUMN "rank" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ree" ADD COLUMN "suggested_questions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ree_feedback" ADD CONSTRAINT "ree_feedback_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ree_feedback" ADD CONSTRAINT "ree_feedback_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ree_profile_vector" ADD CONSTRAINT "ree_profile_vector_ree_id_ree_id_fk" FOREIGN KEY ("ree_id") REFERENCES "public"."ree"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ree_profile_vector_ree_idx" ON "ree_profile_vector" USING btree ("ree_id");--> statement-breakpoint
CREATE INDEX "ree_profile_vector_embedding_idx" ON "ree_profile_vector" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "conversation_trash_idx" ON "conversation" USING btree ("deleted_at") WHERE deleted_at is not null;--> statement-breakpoint
CREATE INDEX "message_ree_idx" ON "message" USING btree ("ree_id","created_at") WHERE role = 'ree';--> statement-breakpoint
CREATE INDEX "ree_public_idx" ON "ree" USING btree ("category","created_at") WHERE is_public and moderated_at is null and deleted_at is null;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_title_check" CHECK (char_length(title) <= 120);