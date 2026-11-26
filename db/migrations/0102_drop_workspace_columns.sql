-- 0102_drop_workspace_columns: the second step of taking the agent workspace and MCP OAuth out
-- (0101 changed the data; see it for why there are two). Released only once release 1 (PR #269) is
-- live and no deployment that reads these tables or columns can come back: it drops them, and the
-- knowledge kind check gets its 0094 definition back. Afterwards the schema is 0094's plus
-- removed_workspace, which the Blob cleanup empties and a later cleanup drops.
--
-- The 0101 guard runs again first, in case a rolled-back deployment let someone write a file in
-- between; a workspace made in between is listed for the Blob cleanup before its table goes.
-- Every statement can run again.
--
-- Instant Rollback after this: only to a deployment at main 4da14488 (release 1, #271) or later.
-- Anything older (d1a39463 and before) still reads the dropped columns and tables, so its API keys,
-- MCP and knowledge pages would answer 500. Roll forward instead.
--
-- Locks: the column drops change only the catalog, but they take ACCESS EXCLUSIVE on api_key and
-- knowledge until the deploy's transaction commits (db:deploy waits at most lock_timeout for them).
-- The kind check therefore comes back NOT VALID -- new and updated rows are checked at once, and no
-- table scan runs under that lock -- and a later migration VALIDATEs it, which takes only SHARE UPDATE
-- EXCLUSIVE and blocks no reads or writes. Until then it is as it has been since 0098: NOT VALID.
DO $guard$
DECLARE
  found text[] := '{}';
  n bigint;
BEGIN
  IF to_regclass('public.agent_workspace_entry') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.agent_workspace_entry WHERE kind = ''file'' AND deleted_at IS NULL' INTO n;
    IF n > 0 THEN found := found || format('%s live workspace file(s) in agent_workspace_entry', n); END IF;
  END IF;
  SELECT count(*) INTO n FROM knowledge k JOIN ree r ON r.id = k.ree_id WHERE k.kind = 'file' AND k.deleted_at IS NULL AND r.deleted_at IS NULL;
  IF n > 0 THEN found := found || format('%s live workspace file source(s) in knowledge', n); END IF;
  IF cardinality(found) > 0 THEN
    RAISE EXCEPTION '0102_drop_workspace_columns refused: workspace data exists (%). Nothing was dropped; see PR #269, then deploy again.', array_to_string(found, ', ');
  END IF;
END
$guard$;--> statement-breakpoint
DO $tombstones$
BEGIN
  IF to_regclass('public.agent_workspace') IS NOT NULL THEN
    INSERT INTO removed_workspace (workspace_id) SELECT id FROM public.agent_workspace ON CONFLICT DO NOTHING;
  END IF;
  IF to_regclass('public.agent_workspace_gone') IS NOT NULL THEN
    INSERT INTO removed_workspace (workspace_id) SELECT workspace_id FROM public.agent_workspace_gone ON CONFLICT DO NOTHING;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'api_key' AND column_name = 'workspace_id') THEN
    UPDATE api_key SET revoked_at = now() WHERE workspace_id IS NOT NULL AND revoked_at IS NULL;
  END IF;
END
$tombstones$;--> statement-breakpoint
DELETE FROM "knowledge" WHERE "kind" = 'file';--> statement-breakpoint
DROP TABLE IF EXISTS "oauth_token";--> statement-breakpoint
DROP TABLE IF EXISTS "oauth_authorization";--> statement-breakpoint
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
-- The 0094 kind check, NOT VALID (see above): every row already passes it, the 'file' rows being gone.
ALTER TABLE "knowledge" DROP CONSTRAINT IF EXISTS "knowledge_kind_check";--> statement-breakpoint
ALTER TABLE "knowledge" ADD CONSTRAINT "knowledge_kind_check" CHECK (kind in ('document', 'audio', 'github', 'page', 'site', 'text')) NOT VALID;
