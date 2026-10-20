-- What the website widget was asked, per library. requirement.md 9.4,
-- lib/application/embed/exchanges.ts.
--
-- The request log keeps no query text (architecture.md 17.1): a caller's
-- question is the caller's. A widget question is different: a visitor asked
-- the *owner's* site, and the owner wants to know what their visitors ask
-- and what they were told -- which questions the library could not answer,
-- which pages it keeps citing -- to grow the library from it. So this table
-- holds the question and the answer, scoped to the library it was asked of,
-- and nothing of the visitor beyond the site they asked from. The owner's
-- own try-outs from the dashboard are marked as previews.

CREATE TABLE IF NOT EXISTS "widget_exchange" (
  "id" uuid PRIMARY KEY,
  "library_id" uuid NOT NULL REFERENCES "library"("id"),
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id"),
  "site_key_id" uuid REFERENCES "site_key"("id") ON DELETE SET NULL,
  "origin" text NOT NULL,
  "preview" boolean NOT NULL DEFAULT false,
  "question" text NOT NULL,
  "rewritten_query" text,
  "outcome" text NOT NULL,
  "answer" text,
  "sources" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "latency_ms" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "widget_exchange_library_time_idx" ON "widget_exchange" ("library_id", "created_at");
