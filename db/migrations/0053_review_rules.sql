-- The rules layer of public review. review-visibility-proposal.md 6.1,
-- lib/domain/auto-review.ts, lib/domain/fingerprint.ts.
--
-- The thresholds the layer decides by, kept with a history like retrieval's
-- tunables; and a content sketch per version, for the duplicate check
-- against published libraries.

CREATE TABLE IF NOT EXISTS "review_config" (
  "id" uuid PRIMARY KEY,
  "trust_min" integer NOT NULL,
  "benchmark_min" integer NOT NULL,
  "owner_hit_rate_min" integer NOT NULL,
  "duplicate_max" integer NOT NULL,
  "sample_rate" integer NOT NULL,
  "auto_publish" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_config_time_idx" ON "review_config" ("created_at" DESC);
--> statement-breakpoint
ALTER TABLE "library_version" ADD COLUMN IF NOT EXISTS "content_sketch" jsonb;
