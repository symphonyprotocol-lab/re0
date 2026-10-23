-- Public review before publication is over (2026-10-23). A user library
-- publishes when its build lands, under either visibility; the console keeps
-- a suspension and its lifting, and the expert tag keeps its approval.
-- lib/domain/library.ts (`lifecycleAfterBuild`), review-visibility-proposal.md.
--
-- Libraries the review era left waiting go where the new rule would have put
-- them: live when their current version is indexed, back to draft when not.
-- A model review still queued has nothing to do. Open review rows (a
-- submission or appeal nobody answered) are closed as of now, so nothing
-- reads as pending. The review thresholds leave `review_config`; the expert
-- gate's two columns stay.

UPDATE "library" SET "lifecycle_status" = 'published'
WHERE "is_platform_library" = false
  AND "deleted_at" IS NULL
  AND "lifecycle_status" IN ('submitted', 'reviewing', 'changes_requested')
  AND "index_status" IN ('ready', 'stale');
--> statement-breakpoint
UPDATE "library" SET "lifecycle_status" = 'draft'
WHERE "is_platform_library" = false
  AND "lifecycle_status" IN ('submitted', 'reviewing', 'changes_requested');
--> statement-breakpoint
UPDATE "workflow_operation" SET "status" = 'cancelled', "updated_at" = now()
WHERE "operation_type" = 'model_review' AND "status" IN ('pending', 'running');
--> statement-breakpoint
UPDATE "library_review" SET "decided_at" = now()
WHERE "decided_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "review_config"
  DROP COLUMN IF EXISTS "trust_min",
  DROP COLUMN IF EXISTS "benchmark_min",
  DROP COLUMN IF EXISTS "owner_hit_rate_min",
  DROP COLUMN IF EXISTS "duplicate_max",
  DROP COLUMN IF EXISTS "sample_rate",
  DROP COLUMN IF EXISTS "auto_publish";
