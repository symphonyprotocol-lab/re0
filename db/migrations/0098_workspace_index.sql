-- 0098_workspace_index: the agent workspace's second phase (docs/design/agent-workspace.md §2.2-2.3, §5):
-- files are indexed on request (index_mode, inherited by folder) or because a live Ree binds them, two minutes
-- after their last change, into agent_workspace_passage; a Ree binds folders or files (agent_ree_binding),
-- which become `file` knowledge whose passages are copied from that index. A new file in a published Ree
-- waits for the owner (awaiting_confirmation), and one holding a secret never answers there (secret_found).
-- A file source the owner trashes is kept out of the Ree (agent_ree_file_exclusion). index_spent holds
-- fractional credits: a day's indexing is one metered run, rounded up once.
-- The knowledge kind check comes back NOT VALID (as in 0039 and 0053): every existing row already passed the
-- narrower check it replaces, and drizzle-kit migrate runs all pending files in one transaction, so a VALIDATE
-- here would scan the whole table under the ACCESS EXCLUSIVE lock this ALTER takes anyway. New and updated
-- rows are checked as usual.
CREATE TABLE "agent_ree_binding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ree_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"exclude" text[] DEFAULT '{}'::text[] NOT NULL,
	"auto_enable" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_ree_binding_exclude_check" CHECK (cardinality(exclude) <= 20)
);
--> statement-breakpoint
CREATE TABLE "agent_ree_file_exclusion" (
	"ree_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_ree_file_exclusion_ree_id_entry_id_pk" PRIMARY KEY("ree_id","entry_id")
);
--> statement-breakpoint
CREATE TABLE "agent_workspace_passage" (
	"entry_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"workspace_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"content" text NOT NULL,
	"locator" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_digest" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"embedding_space" uuid NOT NULL,
	CONSTRAINT "agent_workspace_passage_entry_id_ordinal_pk" PRIMARY KEY("entry_id","ordinal")
);
--> statement-breakpoint
ALTER TABLE "knowledge" DROP CONSTRAINT "knowledge_kind_check";--> statement-breakpoint
ALTER TABLE "knowledge" ADD COLUMN "workspace_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge" ADD COLUMN "workspace_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge" ADD COLUMN "awaiting_confirmation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge" ADD COLUMN "secret_found" text;--> statement-breakpoint
ALTER TABLE "agent_workspace_entry" ADD COLUMN "index_mode" text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_workspace_entry" ADD COLUMN "index_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_workspace_entry" ADD COLUMN "index_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_workspace_entry" ADD COLUMN "indexed_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_workspace_entry" ADD COLUMN "index_error" text;--> statement-breakpoint
ALTER TABLE "agent_workspace_usage" ADD COLUMN "index_spent_day" date;--> statement-breakpoint
ALTER TABLE "agent_workspace_usage" ADD COLUMN "index_spent" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_ree_binding" ADD CONSTRAINT "agent_ree_binding_ree_id_ree_id_fk" FOREIGN KEY ("ree_id") REFERENCES "public"."ree"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_ree_binding" ADD CONSTRAINT "agent_ree_binding_workspace_id_agent_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."agent_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_ree_binding" ADD CONSTRAINT "agent_ree_binding_entry_id_agent_workspace_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."agent_workspace_entry"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_ree_file_exclusion" ADD CONSTRAINT "agent_ree_file_exclusion_ree_id_ree_id_fk" FOREIGN KEY ("ree_id") REFERENCES "public"."ree"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_ree_file_exclusion" ADD CONSTRAINT "agent_ree_file_exclusion_entry_id_agent_workspace_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."agent_workspace_entry"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspace_passage" ADD CONSTRAINT "agent_workspace_passage_entry_id_agent_workspace_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."agent_workspace_entry"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_ree_binding_key" ON "agent_ree_binding" USING btree ("ree_id","entry_id");--> statement-breakpoint
CREATE INDEX "agent_ree_binding_workspace_idx" ON "agent_ree_binding" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "agent_workspace_passage_digest_idx" ON "agent_workspace_passage" USING btree ("workspace_id","content_digest","embedding_space");--> statement-breakpoint
CREATE INDEX "agent_workspace_passage_space_idx" ON "agent_workspace_passage" USING btree ("embedding_space","entry_id");--> statement-breakpoint
CREATE INDEX "knowledge_workspace_entry_idx" ON "knowledge" USING btree ("workspace_entry_id") WHERE workspace_entry_id is not null;--> statement-breakpoint
CREATE INDEX "agent_workspace_entry_index_due_idx" ON "agent_workspace_entry" USING btree ("index_due_at") WHERE index_due_at is not null and deleted_at is null;--> statement-breakpoint
ALTER TABLE "knowledge" ADD CONSTRAINT "knowledge_kind_check" CHECK (kind in ('document', 'audio', 'github', 'page', 'site', 'text', 'file')) NOT VALID;--> statement-breakpoint
ALTER TABLE "agent_workspace_entry" ADD CONSTRAINT "agent_workspace_entry_index_mode_check" CHECK (index_mode in ('inherit', 'on', 'off'));