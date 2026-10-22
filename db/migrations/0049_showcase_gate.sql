-- A password and an expiry on a link-only showcase page. lib/domain/showcase.ts
-- (`showcaseGate`), lib/http/showcase-gate.ts.
--
-- The password is an argon2id hash, as the administrator's is. The version
-- bumps on every change, and the visitor's unlock cookie carries the version
-- it was issued for, so a changed password shuts every browser out at once
-- without a table of sessions.

ALTER TABLE "library_showcase" ADD COLUMN IF NOT EXISTS "password_hash" text;
--> statement-breakpoint
ALTER TABLE "library_showcase" ADD COLUMN IF NOT EXISTS "password_version" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "library_showcase" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
