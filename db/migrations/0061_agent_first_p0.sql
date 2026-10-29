-- Agent-first turn, phase P0 (agent-first-proposal.md 3.6, 8.1, 12, 13.1; 2026-10-29).
--
-- The product narrows to data assets, channels and A2A. This migration does the
-- clearing: the two source types that only ever described documentation hosts,
-- the expert-library programme and its self-check questions, the per-retrieval
-- publisher revenue share, the Pro tier, and the leads the shared pages had
-- collected. Nothing here is a compatibility step -- the site has not opened,
-- every row touched is development data, and the proposal rules out keeping
-- old shapes alongside new ones.
--
-- The website widget, the shared pages and MCP are switched off in code
-- (lib/domain/surfaces.ts); their tables stay for the day they come back.

-- ---------------------------------------------------------------- sources
-- `llms_txt` and `openapi` are gone (proposal 3.2, 13.3 item 2). Postgres
-- cannot drop a value from an enum, so the type is rebuilt -- after the
-- libraries built from those sources are removed, leaves first, the way
-- purge-library.ts and delete.ts take a library apart. `usage_event` is the
-- billing ledger: its rows are detached, never deleted. Object-store blobs of
-- those documents are not reachable from SQL and are swept by the uploads
-- purge, which deletes unreferenced objects. The scratch tables are session
-- temp tables dropped by hand, not `ON COMMIT DROP`: the test runner feeds
-- each statement to psql in autocommit mode, where a commit-scoped table
-- would be gone before the second statement ran.
CREATE TEMP TABLE doomed_library AS
  SELECT DISTINCT library_id AS id FROM "source" WHERE "type" IN ('llms_txt', 'openapi');
--> statement-breakpoint
CREATE TEMP TABLE doomed_version AS
  SELECT id FROM "library_version" WHERE library_id IN (SELECT id FROM doomed_library);
--> statement-breakpoint
DELETE FROM "chunk" WHERE library_id IN (SELECT id FROM doomed_library);
--> statement-breakpoint
DELETE FROM "document" WHERE library_id IN (SELECT id FROM doomed_library);
--> statement-breakpoint
DELETE FROM "library_profile_vector" WHERE library_id IN (SELECT id FROM doomed_library);
--> statement-breakpoint
DELETE FROM "library_profile" WHERE library_id IN (SELECT id FROM doomed_library);
--> statement-breakpoint
DELETE FROM "library_score" WHERE library_id IN (SELECT id FROM doomed_library);
--> statement-breakpoint
DELETE FROM "library_faq" WHERE library_id IN (SELECT id FROM doomed_library);
--> statement-breakpoint
DELETE FROM "anchor_leaf"
  WHERE subject_type = 'version' AND subject_id IN (SELECT id::text FROM doomed_version);
--> statement-breakpoint
DELETE FROM "showcase_lead" WHERE library_id IN (SELECT id FROM doomed_library);
--> statement-breakpoint
DELETE FROM "library_showcase" WHERE library_id IN (SELECT id FROM doomed_library);
--> statement-breakpoint
DELETE FROM "widget_exchange" WHERE library_id IN (SELECT id FROM doomed_library);
--> statement-breakpoint
DELETE FROM "site_key" WHERE library_id IN (SELECT id FROM doomed_library);
--> statement-breakpoint
DELETE FROM "library_review" WHERE library_id IN (SELECT id FROM doomed_library);
--> statement-breakpoint
DELETE FROM "library_claim" WHERE library_id IN (SELECT id FROM doomed_library);
--> statement-breakpoint
DELETE FROM "report" WHERE library_id IN (SELECT id FROM doomed_library);
--> statement-breakpoint
UPDATE "usage_event" SET library_id = NULL, version_id = NULL
  WHERE library_id IN (SELECT id FROM doomed_library);
--> statement-breakpoint
DELETE FROM "workflow_operation" WHERE library_id IN (SELECT id FROM doomed_library);
--> statement-breakpoint
DELETE FROM "library_alias" WHERE library_id IN (SELECT id FROM doomed_library);
--> statement-breakpoint
DELETE FROM "library_version" WHERE library_id IN (SELECT id FROM doomed_library);
--> statement-breakpoint
DELETE FROM "source" WHERE library_id IN (SELECT id FROM doomed_library);
--> statement-breakpoint
DELETE FROM "library" WHERE id IN (SELECT id FROM doomed_library);
--> statement-breakpoint
DROP TABLE doomed_version;
--> statement-breakpoint
DROP TABLE doomed_library;
--> statement-breakpoint
ALTER TYPE "source_type" RENAME TO "source_type_old";
--> statement-breakpoint
CREATE TYPE "source_type" AS ENUM ('github', 'website', 'markdown', 'pdf', 'notion');
--> statement-breakpoint
ALTER TABLE "source"
  ALTER COLUMN "type" TYPE "source_type" USING "type"::text::"source_type";
--> statement-breakpoint
DROP TYPE "source_type_old";
--> statement-breakpoint

-- ----------------------------------------------------------- shared pages
-- Proposal 3.6 and 10: the leads visitors left on shared pages are personal
-- data collected for a surface that is now closed; they go with it.
DELETE FROM "showcase_lead";
--> statement-breakpoint

-- --------------------------------------------------- expert libraries, eval
-- The programme, its applications, its thresholds and the owner's self-check
-- questions are deleted (proposal 3.6, 13.3 item 12). Benchmark keeps only
-- the structural score; the keys the question set wrote into stored
-- breakdowns are cleared so a historical row reads like a current one.
DROP TABLE IF EXISTS "library_eval_question";
--> statement-breakpoint
DROP TABLE IF EXISTS "expert_application";
--> statement-breakpoint
DROP TYPE IF EXISTS "expert_application_status";
--> statement-breakpoint
DROP TABLE IF EXISTS "review_config";
--> statement-breakpoint
UPDATE "library_score"
  SET "breakdown" = "breakdown" - 'structural' - 'evalQuestions' - 'evalHits' - 'evalHitRate' - 'evalMrr';
--> statement-breakpoint
ALTER TABLE "library" DROP COLUMN IF EXISTS "expert_tagged_at";
--> statement-breakpoint

-- ----------------------------------------------------------- revenue ledger
-- The per-retrieval share is gone (proposal 3.6, 8.3, 13.3 item 7): no
-- attributable calls, no pool, no allocation. What stays -- monthly close,
-- statements, hold, redeem-as-calls, manual PayPal payout, statement anchoring
-- -- now runs on a plain signed amount ledger per owner workspace that channel
-- subscriptions will feed (proposal 6.9, 12). Everything the old rules
-- computed is development data and is cleared.
DELETE FROM "settlement";
--> statement-breakpoint
DELETE FROM "payout";
--> statement-breakpoint
DELETE FROM "earning_event";
--> statement-breakpoint
DELETE FROM "revenue_period";
--> statement-breakpoint
DROP INDEX IF EXISTS "earning_event_request_uq";
--> statement-breakpoint
DROP INDEX IF EXISTS "earning_event_period_library_idx";
--> statement-breakpoint
ALTER TABLE "earning_event"
  DROP COLUMN "request_id",
  DROP COLUMN "library_id",
  DROP COLUMN "version_id",
  DROP COLUMN "plan_version_id",
  DROP COLUMN "share_rate_bps",
  ADD COLUMN "amount_minor" bigint NOT NULL,
  ADD COLUMN "source" text NOT NULL,
  ADD COLUMN "reference" text;
--> statement-breakpoint
CREATE INDEX "earning_event_period_owner_idx" ON "earning_event" ("period_id", "owner_workspace_id");
--> statement-breakpoint
ALTER TABLE "revenue_period"
  DROP COLUMN "net_revenue_minor",
  DROP COLUMN "total_billed_calls",
  DROP COLUMN "total_attributable_calls",
  DROP COLUMN "share_rate_bps",
  DROP COLUMN "pool_minor",
  ADD COLUMN "total_amount_minor" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "settlement"
  DROP COLUMN "library_id",
  DROP COLUMN "attributable_calls";
--> statement-breakpoint

-- ------------------------------------------------------------------- plans
-- One tier plus the pack (proposal 8.1, 13.3 items 5, 6, 16): Pro is deleted
-- without compensation, Additional Calls are for everyone, the library count
-- is uncapped, content is bounded by the owner's storage tier (500 MB, or
-- 2 GB once the user has bought a pack), and 20 API keys for all.
ALTER TABLE "user" ADD COLUMN "storage_tier" text NOT NULL DEFAULT 'base';
--> statement-breakpoint
-- Anyone whose workspace already bought a pack is on the extended tier.
UPDATE "user" SET "storage_tier" = 'extended', "updated_at" = now()
WHERE "id" IN (
  SELECT wm."user_id" FROM "workspace_member" wm
  JOIN "addon_grant" ag ON ag."workspace_id" = wm."workspace_id"
  WHERE wm."role" = 'owner' AND ag."publisher_account_id" IS NULL
);
--> statement-breakpoint
-- Rows that point at a Pro version go first; the billing mirror keeps its
-- documents (money that was collected) with the link cleared.
UPDATE "billing_document" SET "plan_version_id" = NULL
WHERE "plan_version_id" IN (SELECT "id" FROM "plan_version" WHERE "plan_id" = 'pro');
--> statement-breakpoint
UPDATE "billing_document" SET "subscription_id" = NULL
WHERE "subscription_id" IN (
  SELECT s."id" FROM "subscription" s JOIN "plan_version" pv ON pv."id" = s."plan_version_id"
  WHERE pv."plan_id" = 'pro'
);
--> statement-breakpoint
DELETE FROM "payment_checkout"
WHERE "plan_version_id" IN (SELECT "id" FROM "plan_version" WHERE "plan_id" = 'pro');
--> statement-breakpoint
-- Every workspace has the Free row signup wrote, and Free is also the absence
-- of a row (planWindow falls back to the newest Free version), so Pro rows are
-- dropped rather than moved.
DELETE FROM "subscription"
WHERE "plan_version_id" IN (SELECT "id" FROM "plan_version" WHERE "plan_id" = 'pro');
--> statement-breakpoint
DELETE FROM "plan_version" WHERE "plan_id" = 'pro';
--> statement-breakpoint
DELETE FROM "plan" WHERE "id" = 'pro';
--> statement-breakpoint
ALTER TABLE "plan_version" DROP COLUMN "library_limit";
--> statement-breakpoint
ALTER TABLE "plan_version" DROP COLUMN "library_size_bytes_limit";
--> statement-breakpoint
-- The share rate was the per-retrieval programme's; the channel fee lives on
-- channel plan versions (proposal 6.9), not here.
ALTER TABLE "plan_version" DROP COLUMN "share_rate_bps";
--> statement-breakpoint
-- A new live Free version with 20 keys; everything else copied from the
-- current newest Free version. Versions are immutable, so a new row.
INSERT INTO "plan_version" (
  "id", "plan_id", "price_minor", "currency", "monthly_calls", "api_key_limit",
  "build_base_calls", "build_tokens_per_call", "build_pages_per_call", "capabilities"
)
SELECT '01920000-0000-7000-8000-000000000004', 'free', "price_minor", "currency", "monthly_calls", 20,
  "build_base_calls", "build_tokens_per_call", "build_pages_per_call", "capabilities"
FROM "plan_version" WHERE "plan_id" = 'free'
ORDER BY "created_at" DESC, "id" DESC LIMIT 1
ON CONFLICT ("id") DO NOTHING;
