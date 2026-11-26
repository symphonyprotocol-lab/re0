-- 0096_workspace_review_fixes: the agent workspace's review fixes (PR #257 follow-up). Versions are kept per save,
-- a run of merged saves anchored at its first save (run_started_at; a superseded one points at its successor,
-- squashed_into); ws_append remembers several client tokens; the storage charge and the purge take accounts by
-- charged_at / purged_at; versions get a per-workspace index; a deleted workspace leaves a tombstone.
CREATE TABLE "agent_workspace_gone" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"gone_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "agent_workspace_revision_age_idx";--> statement-breakpoint
ALTER TABLE "agent_workspace_entry" ADD COLUMN "append_tokens" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_workspace_revision" ADD COLUMN "run_started_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_workspace_revision" ADD COLUMN "squashed_into" uuid;--> statement-breakpoint
ALTER TABLE "agent_workspace_usage" ADD COLUMN "charged_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_workspace_usage" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agent_workspace_revision_workspace_idx" ON "agent_workspace_revision" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "agent_workspace_revision_squashed_idx" ON "agent_workspace_revision" USING btree ("workspace_id") WHERE squashed_into is not null;--> statement-breakpoint
CREATE INDEX "agent_workspace_usage_charged_idx" ON "agent_workspace_usage" USING btree ("charged_at");--> statement-breakpoint
CREATE INDEX "agent_workspace_usage_purged_idx" ON "agent_workspace_usage" USING btree ("purged_at");--> statement-breakpoint
ALTER TABLE "agent_workspace_entry" DROP COLUMN "append_token";--> statement-breakpoint
-- Versions saved before this have one save each; their run started when they were made.
UPDATE "agent_workspace_revision" SET "run_started_at" = "created_at";--> statement-breakpoint
-- A deleted workspace (its owner's account, by cascade) leaves a tombstone, so the orphan sweep removes its Blob objects.
CREATE FUNCTION "agent_workspace_gone_on_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "agent_workspace_gone" ("workspace_id") VALUES (OLD."id") ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "agent_workspace_gone_on_delete" AFTER DELETE ON "agent_workspace" FOR EACH ROW EXECUTE FUNCTION "agent_workspace_gone_on_delete"();
