-- 0101_drop_workspace_oauth: the first of two steps that take the agent workspace (0095, 0096, 0098,
-- 0099, 0100) and OAuth for the MCP server (0097) back out, both dropped by product decision on
-- 2026-11-26. Release PR #267 shipped them to production, so they are undone by new migrations.
--
-- Two steps, because production migrates at the end of the build while the previous deployment
-- (whose code still reads these tables and columns -- api_key's workspace and OAuth columns, the
-- knowledge list's workspace path, a Ree's bindings) keeps serving until the new one takes over, and
-- an Instant Rollback returns to that code. This step only changes data: every table, column and
-- foreign key stays, so the old code and the new both run on it. 0102, released once this is live,
-- drops the tables and columns and restores the 0094 kind check.
--
-- Guard first: it refuses -- and the deploy's one transaction rolls back, nothing changed -- while
-- a workspace holds a live file (one not in the trash), or a live Ree still answers from a
-- workspace file (`knowledge.kind = 'file'`). Then:
-- * every workspace's id goes into removed_workspace, the only list the Blob cleanup
--   (lib/services/removed-workspace-blobs.ts) deletes `workspace/<id>/` objects for;
-- * a workspace key (workspace_id set) is revoked: once 0102 drops that column it would read as an
--   account key, with access it never had;
-- * an OAuth connection's key is revoked and given a digest no key can hash to, so its row, its
--   posts' api_key_id and its usage stay, and key_digest is NOT NULL again; its tokens and pending
--   authorizations are deleted;
-- * file sources left in the trash or in deleted Rees are deleted (their chunks cascade);
-- * the workspace's contents -- trashed files and folders, versions, passages, bindings, uploads,
--   usage -- are deleted; the workspace rows themselves stay until 0102;
-- * the workspace rate limits and ceilings the console stored are removed.
-- A day's index run still open is settled by the metered-run reaper (metered-work.ts).
--
-- Every statement can run again: production runs the file in one transaction, the test runner one
-- statement at a time, and a run stopped half-way picks up where it left off.
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
    RAISE EXCEPTION '0101_drop_workspace_oauth refused: workspace data exists (%). Nothing was changed; see PR #269 for what to do, then deploy again.', array_to_string(found, ', ');
  END IF;
END
$guard$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "removed_workspace" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $tombstones$
BEGIN
  IF to_regclass('public.agent_workspace') IS NOT NULL THEN
    INSERT INTO removed_workspace (workspace_id) SELECT id FROM public.agent_workspace ON CONFLICT DO NOTHING;
  END IF;
  /* Workspaces of deleted accounts left only a tombstone (0096). */
  IF to_regclass('public.agent_workspace_gone') IS NOT NULL THEN
    INSERT INTO removed_workspace (workspace_id) SELECT workspace_id FROM public.agent_workspace_gone ON CONFLICT DO NOTHING;
  END IF;
END
$tombstones$;--> statement-breakpoint
DO $keys$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'api_key' AND column_name = 'workspace_id') THEN
    UPDATE api_key SET revoked_at = now() WHERE workspace_id IS NOT NULL AND revoked_at IS NULL;
  END IF;
  /* An OAuth key has no secret (key_digest null); the check said so, and goes with OAuth. */
  ALTER TABLE api_key DROP CONSTRAINT IF EXISTS api_key_oauth_check;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'api_key' AND column_name = 'oauth_client_id') THEN
    UPDATE api_key SET revoked_at = now() WHERE oauth_client_id IS NOT NULL AND revoked_at IS NULL;
  END IF;
  /* Not hex, so no key's HMAC digest can equal it; unique per row, as api_key_digest_key wants. */
  UPDATE api_key SET key_digest = 'removed-oauth:' || id::text, revoked_at = coalesce(revoked_at, now()) WHERE key_digest IS NULL;
END
$keys$;--> statement-breakpoint
ALTER TABLE "api_key" ALTER COLUMN "key_digest" SET NOT NULL;--> statement-breakpoint
DO $oauth$
BEGIN
  IF to_regclass('public.oauth_token') IS NOT NULL THEN DELETE FROM public.oauth_token; END IF;
  IF to_regclass('public.oauth_authorization') IS NOT NULL THEN DELETE FROM public.oauth_authorization; END IF;
END
$oauth$;--> statement-breakpoint
DELETE FROM "knowledge" WHERE "kind" = 'file';--> statement-breakpoint
DO $contents$
BEGIN
  /* Versions, passages, bindings and exclusions go with their entries (ON DELETE CASCADE). */
  IF to_regclass('public.agent_workspace_entry') IS NOT NULL THEN DELETE FROM public.agent_workspace_entry; END IF;
  IF to_regclass('public.agent_workspace_blob') IS NOT NULL THEN DELETE FROM public.agent_workspace_blob; END IF;
  IF to_regclass('public.agent_workspace_upload') IS NOT NULL THEN DELETE FROM public.agent_workspace_upload; END IF;
  IF to_regclass('public.agent_workspace_usage') IS NOT NULL THEN DELETE FROM public.agent_workspace_usage; END IF;
END
$contents$;--> statement-breakpoint
DELETE FROM "rate_limit_setting" WHERE "name" IN ('workspaceRead', 'workspaceWrite', 'workspaceGrep');--> statement-breakpoint
DELETE FROM "limit_ceiling_setting" WHERE "key" IN ('workspaceWritesPerDay', 'workspaceDebtLimit', 'workspaceFreeMb', 'workspaceIndexBudget');--> statement-breakpoint
DELETE FROM "rate_limit_exemption" WHERE "limits" <@ ARRAY['workspaceRead', 'workspaceWrite', 'workspaceGrep']::text[];--> statement-breakpoint
UPDATE "rate_limit_exemption" SET "limits" = array_remove(array_remove(array_remove("limits", 'workspaceRead'), 'workspaceWrite'), 'workspaceGrep') WHERE "limits" && ARRAY['workspaceRead', 'workspaceWrite', 'workspaceGrep']::text[];
