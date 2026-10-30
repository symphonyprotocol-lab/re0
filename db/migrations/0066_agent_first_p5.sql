-- Agent-first turn, phase P5 (agent-first-proposal.md 3.5, 13.1, 13.3 item 14;
-- 2026-10-30).
--
-- The internal rename: every table, column, constraint and index whose name
-- says library now says asset. Renames only -- no row is copied or rewritten
-- and nothing is dropped, so asset ids, version ids and every anchored leaf
-- stay exactly as they were (lib/domain/anchor-leaf.ts hashes values, never
-- column names). Postgres keeps foreign keys, grants and row types attached
-- through a rename. Migrations before this one keep the old names by design.
--
-- Written for the integration runner, which feeds each statement to psql in
-- autocommit mode: no BEGIN, no temp tables.

-- ------------------------------------------------------------------- tables
ALTER TABLE "library" RENAME TO "asset";
--> statement-breakpoint
ALTER TABLE "library_alias" RENAME TO "asset_alias";
--> statement-breakpoint
ALTER TABLE "library_claim" RENAME TO "asset_claim";
--> statement-breakpoint
ALTER TABLE "library_faq" RENAME TO "asset_faq";
--> statement-breakpoint
ALTER TABLE "library_profile" RENAME TO "asset_profile";
--> statement-breakpoint
ALTER TABLE "library_profile_vector" RENAME TO "asset_profile_vector";
--> statement-breakpoint
ALTER TABLE "library_review" RENAME TO "asset_review";
--> statement-breakpoint
ALTER TABLE "library_score" RENAME TO "asset_score";
--> statement-breakpoint
ALTER TABLE "library_showcase" RENAME TO "asset_showcase";
--> statement-breakpoint
ALTER TABLE "library_showcase_daily" RENAME TO "asset_showcase_daily";
--> statement-breakpoint
ALTER TABLE "library_version" RENAME TO "asset_version";
--> statement-breakpoint
ALTER TABLE "policy_library_entry" RENAME TO "policy_asset_entry";
--> statement-breakpoint

-- ------------------------------------------------------------------ columns
ALTER TABLE "asset" RENAME COLUMN "is_platform_library" TO "is_platform_asset";
--> statement-breakpoint
ALTER TABLE "asset_alias" RENAME COLUMN "library_id" TO "asset_id";
--> statement-breakpoint
ALTER TABLE "asset_claim" RENAME COLUMN "library_id" TO "asset_id";
--> statement-breakpoint
ALTER TABLE "asset_faq" RENAME COLUMN "library_id" TO "asset_id";
--> statement-breakpoint
ALTER TABLE "asset_profile" RENAME COLUMN "library_id" TO "asset_id";
--> statement-breakpoint
ALTER TABLE "asset_profile_vector" RENAME COLUMN "library_id" TO "asset_id";
--> statement-breakpoint
ALTER TABLE "asset_review" RENAME COLUMN "library_id" TO "asset_id";
--> statement-breakpoint
ALTER TABLE "asset_score" RENAME COLUMN "library_id" TO "asset_id";
--> statement-breakpoint
ALTER TABLE "asset_showcase" RENAME COLUMN "library_id" TO "asset_id";
--> statement-breakpoint
ALTER TABLE "asset_version" RENAME COLUMN "library_id" TO "asset_id";
--> statement-breakpoint
ALTER TABLE "chunk" RENAME COLUMN "library_id" TO "asset_id";
--> statement-breakpoint
ALTER TABLE "document" RENAME COLUMN "library_id" TO "asset_id";
--> statement-breakpoint
ALTER TABLE "domain_verification" RENAME COLUMN "consumed_library_id" TO "consumed_asset_id";
--> statement-breakpoint
ALTER TABLE "llm_cost_event" RENAME COLUMN "library_public_id" TO "asset_public_id";
--> statement-breakpoint
ALTER TABLE "report" RENAME COLUMN "library_id" TO "asset_id";
--> statement-breakpoint
ALTER TABLE "request_log" RENAME COLUMN "library_public_id" TO "asset_public_id";
--> statement-breakpoint
ALTER TABLE "showcase_lead" RENAME COLUMN "library_id" TO "asset_id";
--> statement-breakpoint
ALTER TABLE "site_key" RENAME COLUMN "library_id" TO "asset_id";
--> statement-breakpoint
ALTER TABLE "source" RENAME COLUMN "library_id" TO "asset_id";
--> statement-breakpoint
ALTER TABLE "usage_event" RENAME COLUMN "library_id" TO "asset_id";
--> statement-breakpoint
ALTER TABLE "widget_exchange" RENAME COLUMN "library_id" TO "asset_id";
--> statement-breakpoint
ALTER TABLE "workflow_operation" RENAME COLUMN "library_id" TO "asset_id";
--> statement-breakpoint

-- ------------------------------------------------------------- constraints
-- Primary keys and unique constraints take their index's name with them.
ALTER TABLE "asset" RENAME CONSTRAINT "library_access_check" TO "asset_access_check";
--> statement-breakpoint
ALTER TABLE "asset" RENAME CONSTRAINT "library_kind_check" TO "asset_kind_check";
--> statement-breakpoint
ALTER TABLE "asset" RENAME CONSTRAINT "library_owner_workspace_id_workspace_id_fk" TO "asset_owner_workspace_id_workspace_id_fk";
--> statement-breakpoint
ALTER TABLE "asset" RENAME CONSTRAINT "library_pkey" TO "asset_pkey";
--> statement-breakpoint
ALTER TABLE "asset_alias" RENAME CONSTRAINT "library_alias_library_id_library_id_fk" TO "asset_alias_asset_id_asset_id_fk";
--> statement-breakpoint
ALTER TABLE "asset_alias" RENAME CONSTRAINT "library_alias_pkey" TO "asset_alias_pkey";
--> statement-breakpoint
ALTER TABLE "asset_claim" RENAME CONSTRAINT "library_claim_claimant_workspace_id_workspace_id_fk" TO "asset_claim_claimant_workspace_id_workspace_id_fk";
--> statement-breakpoint
ALTER TABLE "asset_claim" RENAME CONSTRAINT "library_claim_library_id_library_id_fk" TO "asset_claim_asset_id_asset_id_fk";
--> statement-breakpoint
ALTER TABLE "asset_claim" RENAME CONSTRAINT "library_claim_pkey" TO "asset_claim_pkey";
--> statement-breakpoint
ALTER TABLE "asset_faq" RENAME CONSTRAINT "library_faq_library_id_fkey" TO "asset_faq_asset_id_fkey";
--> statement-breakpoint
ALTER TABLE "asset_faq" RENAME CONSTRAINT "library_faq_pkey" TO "asset_faq_pkey";
--> statement-breakpoint
ALTER TABLE "asset_faq" RENAME CONSTRAINT "library_faq_workspace_id_fkey" TO "asset_faq_workspace_id_fkey";
--> statement-breakpoint
ALTER TABLE "asset_profile" RENAME CONSTRAINT "library_profile_library_id_fkey" TO "asset_profile_asset_id_fkey";
--> statement-breakpoint
ALTER TABLE "asset_profile" RENAME CONSTRAINT "library_profile_pkey" TO "asset_profile_pkey";
--> statement-breakpoint
ALTER TABLE "asset_profile" RENAME CONSTRAINT "library_profile_version_id_fkey" TO "asset_profile_version_id_fkey";
--> statement-breakpoint
ALTER TABLE "asset_profile_vector" RENAME CONSTRAINT "library_profile_vector_library_id_fkey" TO "asset_profile_vector_asset_id_fkey";
--> statement-breakpoint
ALTER TABLE "asset_profile_vector" RENAME CONSTRAINT "library_profile_vector_pkey" TO "asset_profile_vector_pkey";
--> statement-breakpoint
ALTER TABLE "asset_profile_vector" RENAME CONSTRAINT "library_profile_vector_version_id_fkey" TO "asset_profile_vector_version_id_fkey";
--> statement-breakpoint
ALTER TABLE "asset_review" RENAME CONSTRAINT "library_review_library_id_library_id_fk" TO "asset_review_asset_id_asset_id_fk";
--> statement-breakpoint
ALTER TABLE "asset_review" RENAME CONSTRAINT "library_review_pkey" TO "asset_review_pkey";
--> statement-breakpoint
ALTER TABLE "asset_review" RENAME CONSTRAINT "library_review_version_id_library_version_id_fk" TO "asset_review_version_id_asset_version_id_fk";
--> statement-breakpoint
ALTER TABLE "asset_score" RENAME CONSTRAINT "library_score_library_id_library_id_fk" TO "asset_score_asset_id_asset_id_fk";
--> statement-breakpoint
ALTER TABLE "asset_score" RENAME CONSTRAINT "library_score_pkey" TO "asset_score_pkey";
--> statement-breakpoint
ALTER TABLE "asset_showcase" RENAME CONSTRAINT "library_showcase_library_id_fkey" TO "asset_showcase_asset_id_fkey";
--> statement-breakpoint
ALTER TABLE "asset_showcase" RENAME CONSTRAINT "library_showcase_pkey" TO "asset_showcase_pkey";
--> statement-breakpoint
ALTER TABLE "asset_showcase" RENAME CONSTRAINT "library_showcase_site_key_id_fkey" TO "asset_showcase_site_key_id_fkey";
--> statement-breakpoint
ALTER TABLE "asset_showcase" RENAME CONSTRAINT "library_showcase_workspace_id_fkey" TO "asset_showcase_workspace_id_fkey";
--> statement-breakpoint
ALTER TABLE "asset_showcase_daily" RENAME CONSTRAINT "library_showcase_daily_pkey" TO "asset_showcase_daily_pkey";
--> statement-breakpoint
ALTER TABLE "asset_showcase_daily" RENAME CONSTRAINT "library_showcase_daily_showcase_id_fkey" TO "asset_showcase_daily_showcase_id_fkey";
--> statement-breakpoint
ALTER TABLE "asset_version" RENAME CONSTRAINT "library_version_library_id_library_id_fk" TO "asset_version_asset_id_asset_id_fk";
--> statement-breakpoint
ALTER TABLE "asset_version" RENAME CONSTRAINT "library_version_pkey" TO "asset_version_pkey";
--> statement-breakpoint
ALTER TABLE "chunk" RENAME CONSTRAINT "chunk_library_id_library_id_fk" TO "chunk_asset_id_asset_id_fk";
--> statement-breakpoint
ALTER TABLE "chunk" RENAME CONSTRAINT "chunk_version_id_library_version_id_fk" TO "chunk_version_id_asset_version_id_fk";
--> statement-breakpoint
ALTER TABLE "document" RENAME CONSTRAINT "document_library_id_library_id_fk" TO "document_asset_id_asset_id_fk";
--> statement-breakpoint
ALTER TABLE "document" RENAME CONSTRAINT "document_version_id_library_version_id_fk" TO "document_version_id_asset_version_id_fk";
--> statement-breakpoint
ALTER TABLE "domain_verification" RENAME CONSTRAINT "domain_verification_consumed_library_id_fkey" TO "domain_verification_consumed_asset_id_fkey";
--> statement-breakpoint
ALTER TABLE "policy_asset_entry" RENAME CONSTRAINT "policy_library_entry_pkey" TO "policy_asset_entry_pkey";
--> statement-breakpoint
ALTER TABLE "policy_asset_entry" RENAME CONSTRAINT "policy_library_entry_policy_version_id_policy_version_id_fk" TO "policy_asset_entry_policy_version_id_policy_version_id_fk";
--> statement-breakpoint
ALTER TABLE "report" RENAME CONSTRAINT "report_library_id_library_id_fk" TO "report_asset_id_asset_id_fk";
--> statement-breakpoint
ALTER TABLE "showcase_lead" RENAME CONSTRAINT "showcase_lead_library_id_fkey" TO "showcase_lead_asset_id_fkey";
--> statement-breakpoint
ALTER TABLE "site_key" RENAME CONSTRAINT "site_key_library_id_fkey" TO "site_key_asset_id_fkey";
--> statement-breakpoint
ALTER TABLE "source" RENAME CONSTRAINT "source_library_id_library_id_fk" TO "source_asset_id_asset_id_fk";
--> statement-breakpoint
ALTER TABLE "usage_event" RENAME CONSTRAINT "usage_event_library_id_library_id_fk" TO "usage_event_asset_id_asset_id_fk";
--> statement-breakpoint
ALTER TABLE "usage_event" RENAME CONSTRAINT "usage_event_version_id_library_version_id_fk" TO "usage_event_version_id_asset_version_id_fk";
--> statement-breakpoint
ALTER TABLE "widget_exchange" RENAME CONSTRAINT "widget_exchange_library_id_fkey" TO "widget_exchange_asset_id_fkey";
--> statement-breakpoint
ALTER TABLE "workflow_operation" RENAME CONSTRAINT "workflow_operation_library_id_library_id_fk" TO "workflow_operation_asset_id_asset_id_fk";
--> statement-breakpoint

-- ------------------------------------------------------------------ indexes
ALTER INDEX "chunk_library_version_idx" RENAME TO "chunk_asset_version_idx";
--> statement-breakpoint
ALTER INDEX "library_alias_uq" RENAME TO "asset_alias_uq";
--> statement-breakpoint
ALTER INDEX "library_claim_claimant_idx" RENAME TO "asset_claim_claimant_idx";
--> statement-breakpoint
ALTER INDEX "library_claim_pending_uq" RENAME TO "asset_claim_pending_uq";
--> statement-breakpoint
ALTER INDEX "library_faq_library_idx" RENAME TO "asset_faq_asset_idx";
--> statement-breakpoint
ALTER INDEX "library_lifecycle_idx" RENAME TO "asset_lifecycle_idx";
--> statement-breakpoint
ALTER INDEX "library_owner_idx" RENAME TO "asset_owner_idx";
--> statement-breakpoint
ALTER INDEX "library_platform_idx" RENAME TO "asset_platform_idx";
--> statement-breakpoint
ALTER INDEX "library_profile_library_idx" RENAME TO "asset_profile_asset_idx";
--> statement-breakpoint
ALTER INDEX "library_profile_search_idx" RENAME TO "asset_profile_search_idx";
--> statement-breakpoint
ALTER INDEX "library_profile_vector_hnsw_idx" RENAME TO "asset_profile_vector_hnsw_idx";
--> statement-breakpoint
ALTER INDEX "library_profile_vector_library_idx" RENAME TO "asset_profile_vector_asset_idx";
--> statement-breakpoint
ALTER INDEX "library_profile_vector_uq" RENAME TO "asset_profile_vector_uq";
--> statement-breakpoint
ALTER INDEX "library_profile_version_uq" RENAME TO "asset_profile_version_uq";
--> statement-breakpoint
ALTER INDEX "library_public_id_uq" RENAME TO "asset_public_id_uq";
--> statement-breakpoint
ALTER INDEX "library_score_current_idx" RENAME TO "asset_score_current_idx";
--> statement-breakpoint
ALTER INDEX "library_showcase_library_uq" RENAME TO "asset_showcase_asset_uq";
--> statement-breakpoint
ALTER INDEX "library_showcase_previous_slug_idx" RENAME TO "asset_showcase_previous_slug_idx";
--> statement-breakpoint
ALTER INDEX "library_showcase_slug_uq" RENAME TO "asset_showcase_slug_uq";
--> statement-breakpoint
ALTER INDEX "library_showcase_workspace_idx" RENAME TO "asset_showcase_workspace_idx";
--> statement-breakpoint
ALTER INDEX "library_version_label_uq" RENAME TO "asset_version_label_uq";
--> statement-breakpoint
ALTER INDEX "library_version_library_idx" RENAME TO "asset_version_asset_idx";
--> statement-breakpoint
ALTER INDEX "site_key_library_idx" RENAME TO "site_key_asset_idx";
--> statement-breakpoint
ALTER INDEX "source_library_idx" RENAME TO "source_asset_idx";
--> statement-breakpoint
ALTER INDEX "usage_event_library_time_idx" RENAME TO "usage_event_asset_time_idx";
--> statement-breakpoint
ALTER INDEX "widget_exchange_library_time_idx" RENAME TO "widget_exchange_asset_time_idx";
--> statement-breakpoint
ALTER INDEX "workflow_operation_library_idx" RENAME TO "workflow_operation_asset_idx";
--> statement-breakpoint

-- ---------------------------------------------------- not-null constraints
-- Postgres 18 (Neon) records each NOT NULL as a named constraint, named after
-- the table and column it was created on; Postgres 16 (the integration
-- runner) has none, so this renames whatever the server has and is a no-op
-- there. One statement: a DO block is a single autocommitted command.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conrelid::regclass AS tbl, conname
      FROM pg_constraint
     WHERE connamespace = 'public'::regnamespace AND contype = 'n' AND conname LIKE '%library%'
  LOOP
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.tbl, r.conname, replace(r.conname, 'library', 'asset'));
  END LOOP;
END $$;
