-- The model layer of public review and the owner's appeal.
-- review-visibility-proposal.md 6.2 and 6.3, lib/domain/model-review.ts,
-- lib/domain/library.ts (`appealableDecision`).
--
-- A model's review is one more `library_review` row (stage `model`) and one
-- more `llm_cost_event`, told apart from answers by `purpose`. An owner's
-- appeal is a row that names the machine decision it disputes.

ALTER TABLE "library_review" ADD COLUMN IF NOT EXISTS "appeal_of" uuid;
--> statement-breakpoint
ALTER TABLE "llm_cost_event" ADD COLUMN IF NOT EXISTS "purpose" text NOT NULL DEFAULT 'answer';
