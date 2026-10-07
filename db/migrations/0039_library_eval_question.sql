-- A library's test set. requirement.md 6.3, lib/domain/benchmark.ts.
--
-- The Benchmark Score was defined as coverage, citation completeness,
-- duplication "and test-set performance", and only the first three existed:
-- the score was computed from what a build can count, which grows with the
-- corpus, so a larger library scored higher whether or not a question could
-- find its answer in it.
--
-- One row is one question and where its answer is. `expected_source` is
-- matched against a returned passage's source URL and document title,
-- `expected_text` against its body; at least one is set. Every build puts the
-- questions to the version it just wrote, through the same recall, fusion and
-- rerank a caller's question goes through, and the hit rate is blended into
-- the Benchmark once a library has enough questions for the rate to mean
-- something. A library with no questions scores exactly as before.
--
-- `last_*` hold the most recent run, so the console can show which questions
-- miss. `last_version_id` has no foreign key: versions are purged, questions
-- are not.

CREATE TABLE IF NOT EXISTS "library_eval_question" (
  "id" uuid PRIMARY KEY,
  "library_id" uuid NOT NULL REFERENCES "library"("id"),
  "question" text NOT NULL,
  "expected_source" text,
  "expected_text" text,
  "last_version_id" uuid,
  "last_rank" integer,
  "last_evaluated_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "library_eval_question_expectation"
    CHECK ("expected_source" IS NOT NULL OR "expected_text" IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS "library_eval_question_library_idx"
  ON "library_eval_question" ("library_id", "created_at");
