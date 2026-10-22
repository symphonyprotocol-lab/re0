-- The owner's submission materials. review-visibility-proposal.md 5,
-- lib/domain/rights.ts, lib/domain/library.ts (`submissionBlockers`).
--
-- A public library brings a rights declaration and a self-check question
-- set before it reaches the review queue. The declaration lives on the
-- library row; the questions share the test-set table, told apart by who
-- wrote them, and only the platform's own (`admin`) move the Benchmark.

ALTER TABLE "library" ADD COLUMN IF NOT EXISTS "rights_declaration" jsonb;
--> statement-breakpoint
ALTER TABLE "library_eval_question" ADD COLUMN IF NOT EXISTS "author" text NOT NULL DEFAULT 'admin';
--> statement-breakpoint
ALTER TABLE "library_eval_question" DROP CONSTRAINT IF EXISTS "library_eval_question_author";
--> statement-breakpoint
ALTER TABLE "library_eval_question" ADD CONSTRAINT "library_eval_question_author" CHECK ("author" in ('owner', 'admin'));
