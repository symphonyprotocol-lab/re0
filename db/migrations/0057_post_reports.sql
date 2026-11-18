-- Trigram search for 发现 → 帖子 (post_search_idx below).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "post_report" (
	"post_id" uuid NOT NULL,
	"reporter_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_report_post_id_reporter_key_pk" PRIMARY KEY("post_id","reporter_key")
);
--> statement-breakpoint
ALTER TABLE "post" DROP CONSTRAINT "post_hidden_by_check";--> statement-breakpoint
-- Re-states 0055's cascading keys: a database that ran 0055 before it was amended (set null) gets them too; elsewhere a no-op change.
ALTER TABLE "ree_public_qa" DROP CONSTRAINT "ree_public_qa_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "ree_public_qa" DROP CONSTRAINT "ree_public_qa_message_id_message_id_fk";
--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "report_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "client_token" uuid;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "summary_answers" jsonb;--> statement-breakpoint
ALTER TABLE "post_report" ADD CONSTRAINT "post_report_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ree_public_qa" ADD CONSTRAINT "ree_public_qa_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ree_public_qa" ADD CONSTRAINT "ree_public_qa_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "post_client_token_key" ON "post" USING btree ("user_id","client_token") WHERE client_token is not null;--> statement-breakpoint
CREATE INDEX "post_search_idx" ON "post" USING gin ((question || ' ' || detail) gin_trgm_ops);--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_hidden_by_check" CHECK (hidden_by is null or hidden_by in ('admin', 'reports'));