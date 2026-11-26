-- 0095_agent_workspace: the shared agent workspace's first phase (docs/design/agent-workspace.md §8):
-- workspaces, their files and folders by path, every version's content in Blob (counted per
-- workspace in agent_workspace_blob), and per-account usage for billing. The tables are prefixed
-- agent_ so `public.workspace` keeps meaning the old app to the cutover tool (scripts/database-cutover.mts).
-- API keys gain what they may do with files: every existing key reads 'none' and keeps exactly what it
-- could do before; a key bound to one workspace (workspace_id) is a workspace key, confined to workspace_root.
CREATE TABLE "agent_workspace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text DEFAULT 'default' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "agent_workspace_name_check" CHECK (char_length(name) between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "agent_workspace_blob" (
	"workspace_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"refs" integer DEFAULT 0 NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "agent_workspace_blob_workspace_id_sha256_pk" PRIMARY KEY("workspace_id","sha256"),
	CONSTRAINT "agent_workspace_blob_refs_check" CHECK (refs >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_workspace_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"media_type" text,
	"size" bigint DEFAULT 0 NOT NULL,
	"sha256" text,
	"etag" text,
	"current_revision_id" uuid,
	"text" text,
	"line_count" integer,
	"updated_by_key_id" uuid,
	"updated_client" text,
	"append_token" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_workspace_entry_kind_check" CHECK (kind in ('file', 'folder')),
	CONSTRAINT "agent_workspace_entry_path_check" CHECK (left(path, 1) = '/' and octet_length(path) <= 1024)
);
--> statement-breakpoint
CREATE TABLE "agent_workspace_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"op" text NOT NULL,
	"user_id" uuid NOT NULL,
	"api_key_id" uuid,
	"client_name" text,
	"saves" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_workspace_revision_op_check" CHECK (op in ('write', 'append', 'edit', 'restore', 'copy'))
);
--> statement-breakpoint
CREATE TABLE "agent_workspace_usage" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"blob_bytes" bigint DEFAULT 0 NOT NULL,
	"database_bytes" bigint DEFAULT 0 NOT NULL,
	"entries" integer DEFAULT 0 NOT NULL,
	"writes_day" date,
	"writes" integer DEFAULT 0 NOT NULL,
	"blob_byte_ms" numeric(40, 0) DEFAULT '0' NOT NULL,
	"database_byte_ms" numeric(40, 0) DEFAULT '0' NOT NULL,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "workspace_access" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "workspace_root" text DEFAULT '/' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "client_name" text;--> statement-breakpoint
ALTER TABLE "agent_workspace" ADD CONSTRAINT "agent_workspace_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspace_blob" ADD CONSTRAINT "agent_workspace_blob_workspace_id_agent_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."agent_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspace_entry" ADD CONSTRAINT "agent_workspace_entry_workspace_id_agent_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."agent_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspace_revision" ADD CONSTRAINT "agent_workspace_revision_entry_id_agent_workspace_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."agent_workspace_entry"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspace_usage" ADD CONSTRAINT "agent_workspace_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_workspace_owner_name_key" ON "agent_workspace" USING btree ("owner_id",lower("name")) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "agent_workspace_blob_released_idx" ON "agent_workspace_blob" USING btree ("released_at") WHERE refs = 0;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_workspace_entry_path_key" ON "agent_workspace_entry" USING btree ("workspace_id",lower("path")) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "agent_workspace_entry_prefix_idx" ON "agent_workspace_entry" USING btree ("workspace_id",lower("path") text_pattern_ops);--> statement-breakpoint
CREATE INDEX "agent_workspace_entry_trash_idx" ON "agent_workspace_entry" USING btree ("workspace_id","deleted_at") WHERE deleted_at is not null;--> statement-breakpoint
CREATE INDEX "agent_workspace_revision_entry_idx" ON "agent_workspace_revision" USING btree ("entry_id","updated_at");--> statement-breakpoint
CREATE INDEX "agent_workspace_revision_age_idx" ON "agent_workspace_revision" USING btree ("updated_at");--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_workspace_id_agent_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."agent_workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_workspace_access_check" CHECK (workspace_access in ('none', 'read', 'write'));--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_workspace_key_check" CHECK (workspace_id is null or (not can_write and workspace_access <> 'none'));