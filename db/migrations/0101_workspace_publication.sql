CREATE TABLE "agent_publish_block" (
	"sha256" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_workspace_publication" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"entry_id" uuid,
	"revision_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"media_type" text NOT NULL,
	"file_name" text NOT NULL,
	"title" text NOT NULL,
	"indexable" boolean DEFAULT false NOT NULL,
	"preview" text,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"suspended_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"revoked_by" uuid,
	CONSTRAINT "agent_workspace_publication_reason_check" CHECK (revoke_reason is null or revoke_reason in ('owner', 'purged', 'admin')),
	CONSTRAINT "agent_workspace_publication_revoked_check" CHECK ((revoked_at is null) = (revoke_reason is null))
);
--> statement-breakpoint
CREATE TABLE "agent_workspace_publication_day" (
	"publication_id" uuid NOT NULL,
	"day" date NOT NULL,
	"downloads" integer DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"page_views" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_workspace_publication_day_publication_id_day_pk" PRIMARY KEY("publication_id","day")
);
--> statement-breakpoint
CREATE TABLE "agent_workspace_publication_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publication_id" uuid NOT NULL,
	"reporter_digest" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handled_at" timestamp with time zone,
	CONSTRAINT "agent_workspace_publication_report_reason_check" CHECK (reason in ('malware', 'phishing', 'illegal', 'infringement', 'personal_data', 'other'))
);
--> statement-breakpoint
ALTER TABLE "notice" DROP CONSTRAINT "notice_kind_check";--> statement-breakpoint
ALTER TABLE "agent_workspace_usage" ADD COLUMN "egress_month" date;--> statement-breakpoint
ALTER TABLE "agent_workspace_usage" ADD COLUMN "egress_month_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_workspace_usage" ADD COLUMN "egress_unbilled_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_workspace_usage" ADD COLUMN "egress_day" date;--> statement-breakpoint
ALTER TABLE "agent_workspace_usage" ADD COLUMN "egress_day_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_workspace_usage" ADD COLUMN "publish_frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_publish_block" ADD CONSTRAINT "agent_publish_block_created_by_administrator_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."administrator"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspace_publication" ADD CONSTRAINT "agent_workspace_publication_workspace_id_agent_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."agent_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspace_publication" ADD CONSTRAINT "agent_workspace_publication_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspace_publication" ADD CONSTRAINT "agent_workspace_publication_entry_id_agent_workspace_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."agent_workspace_entry"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspace_publication_day" ADD CONSTRAINT "agent_workspace_publication_day_publication_id_agent_workspace_publication_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."agent_workspace_publication"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspace_publication_report" ADD CONSTRAINT "agent_workspace_publication_report_publication_id_agent_workspace_publication_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."agent_workspace_publication"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_workspace_publication_public_id_key" ON "agent_workspace_publication" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_workspace_publication_entry_key" ON "agent_workspace_publication" USING btree ("entry_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "agent_workspace_publication_owner_idx" ON "agent_workspace_publication" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_workspace_publication_revision_idx" ON "agent_workspace_publication" USING btree ("revision_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_workspace_publication_report_key" ON "agent_workspace_publication_report" USING btree ("publication_id","reporter_digest");--> statement-breakpoint
CREATE INDEX "agent_workspace_publication_report_open_idx" ON "agent_workspace_publication_report" USING btree ("created_at") WHERE handled_at is null;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_kind_check" CHECK (kind in ('takedown', 'restore', 'credits_adjust', 'kyc', 'payout', 'role', 'verification', 'post_answered', 'post_quoted', 'post_paid_requests', 'post_followup', 'followup_answered', 'chats_removal', 'post_ai_answer', 'visitor_ask_paused', 'publication')) NOT VALID;--> statement-breakpoint
ALTER TABLE "notice" VALIDATE CONSTRAINT "notice_kind_check";