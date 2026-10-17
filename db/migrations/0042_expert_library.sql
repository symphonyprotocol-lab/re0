-- Expert libraries. expert-library-prd.md.
--
-- Revenue share used to follow public review: any claimed, published public
-- library earned on every served call. Upload eligibility and revenue
-- eligibility are now two doors. A library earns only once an administrator
-- has tagged it an expert library -- on the owner's own application -- and
-- only while its owner is on a paid plan. The tag lives on `library`; the
-- application and its history live in `expert_application`.
--
-- The tag is read by one decision, whether a served call earns (commitCall),
-- and never by retrieval or ranking: publisher-revenue-share.md 6.3 forbids
-- revenue facts from touching the candidate order, and this one is no
-- exception.

ALTER TABLE "library"
  ADD COLUMN IF NOT EXISTS "expert_tagged_at" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "expert_application_status" AS ENUM
    ('pending', 'approved', 'rejected', 'withdrawn', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "expert_application" (
  "id" uuid PRIMARY KEY,
  "library_id" uuid NOT NULL REFERENCES "library"("id"),
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id"),
  "status" "expert_application_status" NOT NULL,
  "note" text,
  "decision_reason" text,
  "decided_by_admin_id" uuid,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- One open application per library; history rows are free to pile up.
CREATE UNIQUE INDEX IF NOT EXISTS "expert_application_pending_uq"
  ON "expert_application" ("library_id") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expert_application_library_idx"
  ON "expert_application" ("library_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expert_application_status_idx"
  ON "expert_application" ("status", "created_at" DESC);
