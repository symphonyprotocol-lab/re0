-- Where a site key's widget has actually been seen. requirement.md 9.4,
-- lib/application/embed/origins.ts.
--
-- `site_key.allowed_origins` is what the owner *permits*; it says nothing
-- about which of those sites has pasted the snippet. The dashboard's widget
-- page answers "which websites have integrated the plugin" from this table:
-- one row per key and origin, written when the widget page is served to that
-- parent (`loads`) and when a visitor there asks a question (`questions`).
-- Rows are usage marks, not an audit fact -- a lost write costs a count, and
-- a key's rows go with the key.

CREATE TABLE IF NOT EXISTS "site_key_origin" (
  "id" uuid PRIMARY KEY,
  "site_key_id" uuid NOT NULL REFERENCES "site_key"("id") ON DELETE CASCADE,
  "origin" text NOT NULL,
  "loads" integer NOT NULL DEFAULT 0,
  "questions" integer NOT NULL DEFAULT 0,
  "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_seen_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "site_key_origin_uq" ON "site_key_origin" ("site_key_id", "origin");
