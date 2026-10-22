-- The public-review checklist and the scan's findings per document.
-- review-visibility-proposal.md 4.3 and 4.1, lib/domain/review.ts,
-- lib/domain/ingestion.ts (`safetyFindingsOf`).
--
-- A review decision on a public library now records requirement.md 7.4's
-- five checks, each with a verdict and a note; earlier rows and a private
-- library's safety pause keep NULL. A document keeps which scan rules fired
-- on its file, so the console can show why it is flagged.

ALTER TABLE "library_review" ADD COLUMN IF NOT EXISTS "checklist" jsonb;
--> statement-breakpoint
ALTER TABLE "document" ADD COLUMN IF NOT EXISTS "safety_findings" jsonb NOT NULL DEFAULT '[]'::jsonb;
