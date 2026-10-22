-- The expert application's materials and checklist, and the evaluation gate's
-- thresholds. review-visibility-proposal.md 5.3 and 6.5,
-- lib/domain/expert-library.ts, lib/domain/auto-review.ts.

ALTER TABLE "expert_application" ADD COLUMN IF NOT EXISTS "materials" jsonb;
--> statement-breakpoint
ALTER TABLE "expert_application" ADD COLUMN IF NOT EXISTS "checklist" jsonb;
--> statement-breakpoint
ALTER TABLE "review_config" ADD COLUMN IF NOT EXISTS "expert_min_questions" integer NOT NULL DEFAULT 10;
--> statement-breakpoint
ALTER TABLE "review_config" ADD COLUMN IF NOT EXISTS "expert_hit_rate_min" integer NOT NULL DEFAULT 70;
