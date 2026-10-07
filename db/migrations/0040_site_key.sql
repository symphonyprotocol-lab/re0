-- Publishable keys for the website widget. requirement.md 9.4,
-- lib/domain/site-key.ts.
--
-- A site key is pasted into the owner's HTML, so every visitor can read it;
-- the value is stored in the clear because hashing a public value protects
-- nothing. What limits the key is in its own columns: the origins allowed
-- to embed the widget (enforced by the browser through frame-ancestors) and
-- the Calls it may spend per rolling day from the workspace's quota. One key
-- answers from one library.

CREATE TABLE IF NOT EXISTS "site_key" (
  "id" uuid PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id"),
  "library_id" uuid NOT NULL REFERENCES "library"("id"),
  "name" text NOT NULL,
  "key" text NOT NULL,
  "allowed_origins" jsonb NOT NULL,
  "daily_limit" integer NOT NULL,
  "welcome" text,
  "accent" text NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "site_key_key_uq" ON "site_key" ("key");
CREATE INDEX IF NOT EXISTS "site_key_library_idx" ON "site_key" ("library_id");
