CREATE TABLE "model_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"config_id" uuid,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"seconds" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_call_kind_check" CHECK (kind in ('generation', 'embedding', 'transcription'))
);
--> statement-breakpoint
CREATE TABLE "notice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ref_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notice_kind_check" CHECK (kind in ('takedown', 'restore', 'credits_adjust', 'kyc', 'payout', 'role', 'verification'))
);
--> statement-breakpoint
CREATE TABLE "reembed_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_model_config_id" uuid,
	"to_model_config_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "reembed_job_status_check" CHECK (status in ('running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "verification_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"statement" text NOT NULL,
	"links" text[] DEFAULT '{}'::text[] NOT NULL,
	"metrics" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"rejected_reason" text,
	"closed_by_role_change" boolean DEFAULT false NOT NULL,
	"reviewed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "verification_request_status_check" CHECK (status in ('pending', 'approved', 'rejected', 'closed')),
	CONSTRAINT "verification_request_links_check" CHECK (cardinality(links) <= 3)
);
--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "embedding_next" vector(1536);--> statement-breakpoint
ALTER TABLE "ree" ADD COLUMN IF NOT EXISTS "moderated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ree" ADD COLUMN IF NOT EXISTS "moderated_by" uuid;--> statement-breakpoint
ALTER TABLE "ree" ADD COLUMN IF NOT EXISTS "moderated_reason" text;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reembed_job" ADD CONSTRAINT "reembed_job_to_model_config_id_model_config_id_fk" FOREIGN KEY ("to_model_config_id") REFERENCES "public"."model_config"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_request" ADD CONSTRAINT "verification_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_call_time_idx" ON "model_call" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notice_user_idx" ON "notice" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notice_unread_idx" ON "notice" USING btree ("user_id") WHERE read_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "reembed_job_running_key" ON "reembed_job" USING btree ("status") WHERE status = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "verification_request_pending_key" ON "verification_request" USING btree ("user_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "verification_request_user_idx" ON "verification_request" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "verification_request_status_idx" ON "verification_request" USING btree ("status","created_at");