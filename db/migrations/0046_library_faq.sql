-- The owner's FAQ for a library: recurring widget questions, answered once
-- and built into the library. requirement.md 9.4, lib/domain/faq.ts.
--
-- An entry is a document of the next build (question as title, answer as
-- body, cited to the page it stands for), so a question visitors keep
-- asking meets a chunk written for it instead of a model's paraphrase of
-- six passages. The version remembers the FAQ it was built with
-- (`faq_digest`) so an edit to an entry alone is a change worth a build.

CREATE TABLE IF NOT EXISTS "library_faq" (
  "id" uuid PRIMARY KEY,
  "library_id" uuid NOT NULL REFERENCES "library"("id"),
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id"),
  "question" text NOT NULL,
  "answer" text NOT NULL,
  "page_url" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_faq_library_idx" ON "library_faq" ("library_id", "created_at");
--> statement-breakpoint
ALTER TABLE "library_version" ADD COLUMN IF NOT EXISTS "faq_digest" text;
