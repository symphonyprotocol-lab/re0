-- Fixes from the P1-P5 review (docs/reviews/agent-first-p1-p5-review.md;
-- 2026-10-30). Each section names the finding it serves.
--
-- Written for the integration runner, which feeds each statement to psql in
-- autocommit mode: no BEGIN, no temp tables. Production runs the file inside
-- drizzle's single migration transaction, so nothing here may depend on an
-- enum value added in the same file.

-- ---- M9: a twin answer keeps the passages its sentences cite (source URL, title, section, version) and, when it degraded, the passages it was billed for
--> statement-breakpoint
ALTER TABLE "twin_answer" ADD COLUMN "passages" jsonb NOT NULL DEFAULT '[]'::jsonb;
