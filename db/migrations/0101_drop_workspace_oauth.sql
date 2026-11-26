-- 0101_drop_workspace_oauth: takes the agent workspace (0095, 0096, 0098, 0099, 0100) and OAuth for
-- the MCP server (0097) back out, both dropped by product decision on 2026-11-26. Release PR #267
-- shipped them to production first, so they are undone here, not deleted (as 0090 undid 0089).
-- Afterwards the database is as 0094_api_key_can_write left it, `api_key.can_write` included.
--
-- Guard first: it refuses -- and the deploy's one transaction rolls back, nothing dropped -- while
-- a workspace holds a live file (one not in the trash), or a live Ree still answers from a
-- workspace file (`knowledge.kind = 'file'`). Trashed files, folders, versions, uploads and the
-- index are dropped with their tables; their Blob objects (under `workspace/`) are deleted
-- afterwards by the daily /api/cron/purge-uploads (lib/services/upload-reaper.ts), which only
-- touches that prefix once these tables are gone.
--
-- Then, before columns go:
-- * a workspace key (api_key.workspace_id set) could reach nothing but its workspace; without
--   that column it would read like an account key, so it is revoked;
-- * an OAuth connection's key (oauth_client_id set, no secret of its own) is deleted, so
--   key_digest can be NOT NULL again; posts and usage rows that named it keep their rows
--   (their api_key_id is ON DELETE SET NULL);
-- * file sources left in the trash or in deleted Rees are deleted (their chunks cascade);
-- * the workspace rate limits and ceilings the console stored are removed.
-- A day's index run still open is settled by the metered-run reaper (metered-work.ts).
DO $guard$
DECLARE
  found text[] := '{}';
  n bigint;
BEGIN
  IF to_regclass('public.agent_workspace_entry') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.agent_workspace_entry WHERE kind = ''file'' AND deleted_at IS NULL' INTO n;
    IF n > 0 THEN found := found || format('%s live workspace file(s) in agent_workspace_entry', n); END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'knowledge' AND column_name = 'workspace_entry_id') THEN
    SELECT count(*) INTO n FROM knowledge k JOIN ree r ON r.id = k.ree_id WHERE k.kind = 'file' AND k.deleted_at IS NULL AND r.deleted_at IS NULL;
    IF n > 0 THEN found := found || format('%s live workspace file source(s) in knowledge', n); END IF;
  END IF;
  IF cardinality(found) > 0 THEN
    RAISE EXCEPTION '0101_drop_workspace_oauth refused: workspace data exists (%). Nothing was dropped; move those files to the trash or export them, then deploy again.', array_to_string(found, ', ');
  END IF;
END
$guard$;--> statement-breakpoint
UPDATE "api_key" SET "revoked_at" = now() WHERE "workspace_id" IS NOT NULL AND "revoked_at" IS NULL;--> statement-breakpoint
DELETE FROM "api_key" WHERE "oauth_client_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "knowledge" WHERE "kind" = 'file';--> statement-breakpoint
DELETE FROM "rate_limit_setting" WHERE "name" IN ('workspaceRead', 'workspaceWrite', 'workspaceGrep');--> statement-breakpoint
DELETE FROM "limit_ceiling_setting" WHERE "key" IN ('workspaceWritesPerDay', 'workspaceDebtLimit', 'workspaceFreeMb', 'workspaceIndexBudget');--> statement-breakpoint
DELETE FROM "rate_limit_exemption" WHERE "limits" <@ ARRAY['workspaceRead', 'workspaceWrite', 'workspaceGrep']::text[];--> statement-breakpoint
UPDATE "rate_limit_exemption" SET "limits" = array_remove(array_remove(array_remove("limits", 'workspaceRead'), 'workspaceWrite'), 'workspaceGrep') WHERE "limits" && ARRAY['workspaceRead', 'workspaceWrite', 'workspaceGrep']::text[];--> statement-breakpoint
DROP TABLE IF EXISTS "oauth_token";--> statement-breakpoint
DROP TABLE IF EXISTS "oauth_authorization";--> statement-breakpoint
ALTER TABLE "api_key" DROP CONSTRAINT IF EXISTS "api_key_oauth_check";--> statement-breakpoint
ALTER TABLE "api_key" DROP CONSTRAINT IF EXISTS "api_key_oauth_client_id_oauth_client_id_fk";--> statement-breakpoint
DROP INDEX IF EXISTS "api_key_oauth_client_idx";--> statement-breakpoint
DROP TABLE IF EXISTS "oauth_client";--> statement-breakpoint
DROP TABLE IF EXISTS "agent_ree_file_exclusion";--> statement-breakpoint
DROP TABLE IF EXISTS "agent_ree_binding";--> statement-breakpoint
DROP TABLE IF EXISTS "agent_workspace_passage";--> statement-breakpoint
DROP TABLE IF EXISTS "agent_workspace_upload";--> statement-breakpoint
DROP TABLE IF EXISTS "agent_workspace_revision";--> statement-breakpoint
DROP TABLE IF EXISTS "agent_workspace_entry";--> statement-breakpoint
DROP TABLE IF EXISTS "agent_workspace_blob";--> statement-breakpoint
DROP TABLE IF EXISTS "agent_workspace_usage";--> statement-breakpoint
ALTER TABLE "api_key" DROP CONSTRAINT IF EXISTS "api_key_workspace_key_check";--> statement-breakpoint
ALTER TABLE "api_key" DROP CONSTRAINT IF EXISTS "api_key_workspace_access_check";--> statement-breakpoint
ALTER TABLE "api_key" DROP CONSTRAINT IF EXISTS "api_key_workspace_id_agent_workspace_id_fk";--> statement-breakpoint
DROP TABLE IF EXISTS "agent_workspace";--> statement-breakpoint
DROP FUNCTION IF EXISTS "agent_workspace_gone_on_delete"();--> statement-breakpoint
DROP TABLE IF EXISTS "agent_workspace_gone";--> statement-breakpoint
ALTER TABLE "api_key" ALTER COLUMN "key_digest" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_key" DROP COLUMN IF EXISTS "workspace_access";--> statement-breakpoint
ALTER TABLE "api_key" DROP COLUMN IF EXISTS "workspace_id";--> statement-breakpoint
ALTER TABLE "api_key" DROP COLUMN IF EXISTS "workspace_root";--> statement-breakpoint
ALTER TABLE "api_key" DROP COLUMN IF EXISTS "client_name";--> statement-breakpoint
ALTER TABLE "api_key" DROP COLUMN IF EXISTS "oauth_client_id";--> statement-breakpoint
DROP INDEX IF EXISTS "knowledge_workspace_entry_idx";--> statement-breakpoint
ALTER TABLE "knowledge" DROP COLUMN IF EXISTS "workspace_entry_id";--> statement-breakpoint
ALTER TABLE "knowledge" DROP COLUMN IF EXISTS "workspace_revision_id";--> statement-breakpoint
ALTER TABLE "knowledge" DROP COLUMN IF EXISTS "awaiting_confirmation";--> statement-breakpoint
ALTER TABLE "knowledge" DROP COLUMN IF EXISTS "secret_found";--> statement-breakpoint
-- The kind check gets its 0094 definition back. Every row passes it (the 'file' rows are gone above), and the
-- column drops just took the table's ACCESS EXCLUSIVE lock, so the check is validated in place.
ALTER TABLE "knowledge" DROP CONSTRAINT IF EXISTS "knowledge_kind_check";--> statement-breakpoint
ALTER TABLE "knowledge" ADD CONSTRAINT "knowledge_kind_check" CHECK (kind in ('document', 'audio', 'github', 'page', 'site', 'text'));
