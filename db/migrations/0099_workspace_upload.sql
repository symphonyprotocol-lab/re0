-- 0099_workspace_upload: the agent workspace's third phase (docs/design/agent-workspace.md §3.1, §8):
-- bytes come in through upload URLs (agent_workspace_upload: the ticket, its token as a digest, the parts
-- received and rewritten, and the stitching -- parts done, the resumable SHA-256 state, the store's multipart
-- upload and its lease -- until the file is saved); a version can now be an upload; and an index run that
-- never finishes a file is counted (index_attempts). The op check comes back NOT VALID: every existing row
-- passed the narrower check it replaces (see 0098).
CREATE TABLE "agent_workspace_upload" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"api_key_id" uuid,
	"client" text,
	"path" text NOT NULL,
	"size" bigint NOT NULL,
	"parts" integer NOT NULL,
	"received" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"writes" integer DEFAULT 0 NOT NULL,
	"stitched" integer DEFAULT 0 NOT NULL,
	"hash_state" text,
	"assembly" jsonb,
	"lease_until" timestamp with time zone,
	"if_match" text,
	"if_none_match" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"error" text,
	"sha256" text,
	"revision_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "agent_workspace_upload_status_check" CHECK (status in ('open', 'assembling', 'done', 'failed')),
	CONSTRAINT "agent_workspace_upload_size_check" CHECK (size >= 0 and parts >= 1)
);
--> statement-breakpoint
ALTER TABLE "agent_workspace_revision" DROP CONSTRAINT "agent_workspace_revision_op_check";--> statement-breakpoint
ALTER TABLE "agent_workspace_entry" ADD COLUMN "index_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_workspace_upload" ADD CONSTRAINT "agent_workspace_upload_workspace_id_agent_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."agent_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspace_upload" ADD CONSTRAINT "agent_workspace_upload_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_workspace_upload_token_key" ON "agent_workspace_upload" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "agent_workspace_upload_user_idx" ON "agent_workspace_upload" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "agent_workspace_upload_workspace_idx" ON "agent_workspace_upload" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agent_workspace_upload_expires_idx" ON "agent_workspace_upload" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "agent_workspace_revision" ADD CONSTRAINT "agent_workspace_revision_op_check" CHECK (op in ('write', 'append', 'edit', 'restore', 'copy', 'upload')) NOT VALID;