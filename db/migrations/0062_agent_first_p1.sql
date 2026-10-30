-- Agent-first turn, phase P1 (agent-first-proposal.md 3.2, 3.3, 6.1-6.4, 7.8, 12, 13.1; 2026-10-30).
--
-- Data assets get a type and an access flag, workspaces get a public handle,
-- and channels arrive as the only way an asset is shown to anyone but its
-- owner. `library.visibility` goes: who may see an asset now follows from the
-- channel it sits in and its `access` (proposal 6.2), decided by the Policy
-- Engine before recall. A2A tasks get a durable home, because a serverless
-- function's memory is not one (proposal 7.8).
--
-- The site has not opened; every row reshaped here is development data and
-- nothing is kept for compatibility (proposal 1, 13.3 item 3).
--
-- Written for the integration runner, which feeds each statement to psql in
-- autocommit mode: scratch tables are session temp tables dropped by hand, no
-- `ON COMMIT DROP`, no BEGIN.

-- ------------------------------------------------------------- asset kinds
-- One kind per asset, from its source (proposal 3.2). `post`, `audio` and
-- `qa` are reserved for P3a / P3b; nothing creates them yet. A library with
-- no source row at all can only be an empty upload, which is what it reads as.
ALTER TABLE "library" ADD COLUMN "kind" text;
--> statement-breakpoint
CREATE TEMP TABLE first_source AS
  SELECT DISTINCT ON (library_id) library_id, type::text AS type
  FROM "source" ORDER BY library_id, id;
--> statement-breakpoint
UPDATE "library" l SET "kind" = CASE f.type
    WHEN 'github' THEN 'github'
    WHEN 'website' THEN 'website'
    WHEN 'notion' THEN 'notion'
    ELSE 'upload'
  END
FROM first_source f WHERE f.library_id = l.id;
--> statement-breakpoint
DROP TABLE first_source;
--> statement-breakpoint
UPDATE "library" SET "kind" = 'upload' WHERE "kind" IS NULL;
--> statement-breakpoint
ALTER TABLE "library" ALTER COLUMN "kind" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "library" ADD CONSTRAINT "library_kind_check"
  CHECK ("kind" IN ('website', 'upload', 'github', 'notion', 'post', 'audio', 'qa'));
--> statement-breakpoint

-- ------------------------------------------------------ one source, one asset
-- Proposal 3.1 and 3.3: an asset has exactly one source. A library that grew
-- several (the platform's multi-source libraries, mostly) is split: its first
-- source stays, every other one becomes an asset of its own. None of them
-- keeps version history -- the original's versions and everything derived
-- from them are dropped, its on-chain leaves with them (the public Verifier
-- then answers "version not found" for those anchors, not "mismatch"), and
-- each resulting asset is queued for a first build.
CREATE TEMP TABLE split_library AS
  SELECT library_id AS id FROM "source" GROUP BY library_id HAVING count(*) > 1;
--> statement-breakpoint
CREATE TEMP TABLE split_source AS
  SELECT s.id AS source_id, s.library_id, s.type::text AS type, s.location,
    row_number() OVER (PARTITION BY s.library_id ORDER BY s.id) AS rn,
    gen_random_uuid() AS new_library_id
  FROM "source" s WHERE s.library_id IN (SELECT id FROM split_library);
--> statement-breakpoint
DELETE FROM split_source WHERE rn = 1;
--> statement-breakpoint
CREATE TEMP TABLE split_version AS
  SELECT id FROM "library_version" WHERE library_id IN (SELECT id FROM split_library);
--> statement-breakpoint
DELETE FROM "chunk" WHERE library_id IN (SELECT id FROM split_library);
--> statement-breakpoint
DELETE FROM "document" WHERE library_id IN (SELECT id FROM split_library);
--> statement-breakpoint
DELETE FROM "library_profile_vector" WHERE library_id IN (SELECT id FROM split_library);
--> statement-breakpoint
DELETE FROM "library_profile" WHERE library_id IN (SELECT id FROM split_library);
--> statement-breakpoint
DELETE FROM "library_score" WHERE library_id IN (SELECT id FROM split_library);
--> statement-breakpoint
DELETE FROM "anchor_leaf"
  WHERE subject_type = 'version' AND subject_id IN (SELECT id::text FROM split_version);
--> statement-breakpoint
-- The billing ledger and the review trail are history: detached, not deleted.
UPDATE "usage_event" SET version_id = NULL WHERE version_id IN (SELECT id FROM split_version);
--> statement-breakpoint
UPDATE "library_review" SET version_id = NULL WHERE version_id IN (SELECT id FROM split_version);
--> statement-breakpoint
DELETE FROM "library_version" WHERE id IN (SELECT id FROM split_version);
--> statement-breakpoint
UPDATE "library"
  SET current_version_id = NULL, index_status = 'pending', storage_bytes = 0,
      last_successful_refresh_at = NULL
  WHERE id IN (SELECT id FROM split_library);
--> statement-breakpoint
-- The new asset's id follows its source: a repository is `/owner/repo`, the
-- rest take the original's slug plus the source's position under their own
-- namespace. A split-out id that is already taken (the same repository as
-- another library, say) is not created, and its source is dropped below.
INSERT INTO "library" (
  "id", "public_id", "title", "description", "domain_tag", "language",
  "owner_workspace_id", "is_platform_library", "visibility", "kind",
  "lifecycle_status", "index_status", "rights_declaration"
)
SELECT ss.new_library_id,
  CASE ss.type
    WHEN 'github' THEN '/' || ss.location
    ELSE '/' || (CASE ss.type WHEN 'website' THEN 'websites' WHEN 'notion' THEN 'notion' ELSE 'docs' END)
      || '/' || left(trim(both '-' from regexp_replace(
          lower(regexp_replace(l.public_id, '^/(websites|docs|notion)/', '')),
          '[^a-z0-9._-]+', '-', 'g')), 48)
      || '-' || ss.rn
  END,
  left(CASE WHEN ss.type IN ('website', 'github')
    THEN regexp_replace(ss.location, '^https?://(www\.)?', '')
    ELSE l.title || ' (' || ss.rn || ')' END, 120),
  l.description, l.domain_tag, l.language, l.owner_workspace_id, l.is_platform_library,
  l.visibility,
  CASE ss.type WHEN 'github' THEN 'github' WHEN 'website' THEN 'website' WHEN 'notion' THEN 'notion' ELSE 'upload' END,
  l.lifecycle_status, 'pending', l.rights_declaration
FROM split_source ss JOIN "library" l ON l.id = ss.library_id
-- A repository under a reserved owner (lib/domain/reserved-names.ts) would
-- shadow a namespace; like a taken id, it is not created.
WHERE NOT (ss.type = 'github' AND lower(split_part(ss.location, '/', 1)) IN (
  'a2a', 'about', 'admin', 'api', 'assets', 'audio', 'channels', 'checkout', 'contact',
  'dashboard', 'docs', 'embed', 'files', 'help', 'legal', 'libraries', 'login', 'mcp',
  'notion', 'official', 'playground', 'posts', 'pricing', 'publishers', 'qa', 're0', 'root',
  's', 'status', 'support', 'system', 'u', 'v1', 'websites', 'widget'))
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "source" s SET library_id = ss.new_library_id
  FROM split_source ss
  WHERE s.id = ss.source_id AND EXISTS (SELECT 1 FROM "library" WHERE id = ss.new_library_id);
--> statement-breakpoint
DELETE FROM "source" s USING split_source ss
  WHERE s.id = ss.source_id AND NOT EXISTS (SELECT 1 FROM "library" WHERE id = ss.new_library_id);
--> statement-breakpoint
INSERT INTO "workflow_operation" ("id", "library_id", "operation_type", "status")
SELECT gen_random_uuid(), l.id, 'ingest', 'pending'
FROM "library" l
WHERE l.deleted_at IS NULL
  AND (l.id IN (SELECT id FROM split_library) OR l.id IN (SELECT new_library_id FROM split_source));
--> statement-breakpoint
DROP TABLE split_version;
--> statement-breakpoint
DROP TABLE split_source;
--> statement-breakpoint
DROP TABLE split_library;
--> statement-breakpoint

-- ------------------------------------------------------------------ access
-- Whether an asset in a channel is free or for subscribers (proposal 6.2).
-- Only meaningful inside a channel: moving an asset out resets it to free.
ALTER TABLE "library" ADD COLUMN "access" text NOT NULL DEFAULT 'free';
--> statement-breakpoint
ALTER TABLE "library" ADD CONSTRAINT "library_access_check" CHECK ("access" IN ('free', 'paid'));
--> statement-breakpoint

-- ------------------------------------------------------- workspace handle
-- The workspace's public name (proposal 12): `/u/{handle}`, the user Agent
-- Card, and later the post, audio and Q&A ids. Unique, nullable -- a workspace
-- without one simply has no public page. Existing personal workspaces get one
-- from the owner's email local part, folded to the handle alphabet; one that
-- comes out too short or equal to a reserved name (the list in
-- lib/domain/reserved-names.ts) gets `user-` plus a digest, and a collision
-- gets a digest suffix. The owner can change it from settings.
ALTER TABLE "workspace" ADD COLUMN "handle" text;
--> statement-breakpoint
CREATE TEMP TABLE handle_base AS
  SELECT w.id, w.created_at,
    left(trim(both '-' from regexp_replace(lower(split_part(u.email, '@', 1)), '[^a-z0-9]+', '-', 'g')), 24) AS base
  FROM "workspace" w
  JOIN "workspace_member" m ON m.workspace_id = w.id AND m.role = 'owner'
  JOIN "user" u ON u.id = m.user_id;
--> statement-breakpoint
UPDATE handle_base SET base = 'user-' || substr(md5(id::text), 1, 6)
  WHERE length(base) < 3 OR base IN (
    'a2a', 'about', 'admin', 'api', 'assets', 'audio', 'channels', 'checkout', 'contact',
    'dashboard', 'docs', 'embed', 'files', 'help', 'legal', 'libraries', 'login', 'mcp',
    'notion', 'official', 'opengraph-image', 'playground', 'posts', 'pricing', 'publishers',
    'qa', 're0', 'root', 's', 'status', 'support', 'system', 'u', 'v1', 'websites',
    'well-known', 'widget'
  );
--> statement-breakpoint
UPDATE "workspace" w SET "handle" = ranked.handle
FROM (
  SELECT id,
    CASE WHEN row_number() OVER (PARTITION BY base ORDER BY created_at, id) = 1 THEN base
      ELSE base || '-' || substr(md5(id::text), 1, 8) END AS handle
  FROM handle_base
) ranked
WHERE ranked.id = w.id;
--> statement-breakpoint
DROP TABLE handle_base;
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_handle_uq" ON "workspace" ("handle");
--> statement-breakpoint

-- ---------------------------------------------------------------- channels
-- A channel groups assets and shows them (proposal 6.1). `workspace_id` is
-- null for the platform's own channel, which holds the platform assets
-- (proposal 3.4: "平台资产，放在平台的公开频道里"); every other channel
-- belongs to one workspace. `profile` is the aggregate of its public assets'
-- profiles (proposal 3.7), refreshed when membership or a build changes it.
CREATE TABLE "channel" (
  "id" uuid PRIMARY KEY,
  "slug" text NOT NULL,
  "workspace_id" uuid REFERENCES "workspace"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "description" text,
  "visibility" text NOT NULL DEFAULT 'public',
  "status" text NOT NULL DEFAULT 'active',
  "subscriber_daily_limit" integer,
  "profile" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "channel_visibility_check" CHECK ("visibility" IN ('public', 'private')),
  CONSTRAINT "channel_status_check" CHECK ("status" IN ('active', 'suspended'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_slug_uq" ON "channel" ("slug");
--> statement-breakpoint
CREATE INDEX "channel_workspace_idx" ON "channel" ("workspace_id");
--> statement-breakpoint
-- `asset_id` is the primary key: an asset belongs to at most one channel.
CREATE TABLE "channel_asset" (
  "asset_id" uuid PRIMARY KEY REFERENCES "library"("id") ON DELETE CASCADE,
  "channel_id" uuid NOT NULL REFERENCES "channel"("id") ON DELETE CASCADE,
  "pinned_at" timestamp with time zone,
  "published_at" timestamp with time zone NOT NULL DEFAULT now(),
  "scheduled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "channel_asset_channel_idx" ON "channel_asset" ("channel_id", "published_at" DESC);
--> statement-breakpoint
-- Who read, asked or retrieved from a channel on a given day, for the
-- directory's activity term (proposal 6.4): one row per distinct visitor per
-- day, keyed by user, by calling workspace, or by the hashed anonymous key the
-- rate limiter already uses. Never an address, never a query.
CREATE TABLE "channel_visit" (
  "channel_id" uuid NOT NULL REFERENCES "channel"("id") ON DELETE CASCADE,
  "visitor_kind" text NOT NULL,
  "visitor_key" text NOT NULL,
  "visited_on" date NOT NULL,
  PRIMARY KEY ("channel_id", "visitor_kind", "visitor_key", "visited_on"),
  CONSTRAINT "channel_visit_kind_check" CHECK ("visitor_kind" IN ('user', 'workspace', 'anonymous'))
);
--> statement-breakpoint
CREATE INDEX "channel_visit_day_idx" ON "channel_visit" ("visited_on");
--> statement-breakpoint
INSERT INTO "channel" ("id", "slug", "workspace_id", "title", "description")
VALUES ('01920000-0000-7000-8000-0000000000c1', 're0', NULL, 're0',
  'Assets the platform publishes itself.')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "channel_asset" ("asset_id", "channel_id", "published_at")
SELECT id, '01920000-0000-7000-8000-0000000000c1', created_at
FROM "library" WHERE is_platform_library AND deleted_at IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ------------------------------------------------------- visibility column
-- Gone (proposal 12): an asset outside any channel, or in a private one, is
-- its owner's alone; one in a public channel is everyone's if free.
DROP INDEX IF EXISTS "library_visibility_lifecycle_idx";
--> statement-breakpoint
ALTER TABLE "library" DROP COLUMN "visibility";
--> statement-breakpoint
DROP TYPE IF EXISTS "visibility";
--> statement-breakpoint
CREATE INDEX "library_lifecycle_idx" ON "library" ("lifecycle_status", "index_status");
--> statement-breakpoint

-- ----------------------------------------------------- directory ranking
-- The directory's 热门 weights and freshness half-life (proposal 6.4), in
-- basis points so the append-only retrieval configuration stays integers.
ALTER TABLE "retrieval_config"
  ADD COLUMN "channel_activity_bps" integer NOT NULL DEFAULT 5000,
  ADD COLUMN "channel_freshness_bps" integer NOT NULL DEFAULT 2500,
  ADD COLUMN "channel_quality_bps" integer NOT NULL DEFAULT 2500,
  ADD COLUMN "channel_half_life_days" integer NOT NULL DEFAULT 14;
--> statement-breakpoint

-- ---------------------------------------------------------------- A2A tasks
-- The SDK's task store and event bus live in one function instance's memory;
-- on Vercel the next request may land elsewhere (proposal 7.8). Tasks live
-- here instead, scoped by tenant and by the calling workspace (null for an
-- anonymous caller). `history` and `artifacts` hold the message bodies and
-- are cleared at `body_purge_at` (proposal 10: 30 days), leaving the ids and
-- the metering facts.
CREATE TABLE "a2a_task" (
  "id" text PRIMARY KEY,
  "context_id" text NOT NULL,
  "workspace_id" uuid REFERENCES "workspace"("id") ON DELETE CASCADE,
  "api_key_id" uuid,
  "tenant" text NOT NULL DEFAULT '',
  "skill" text,
  "state" text NOT NULL,
  "status" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "history" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "artifacts" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "metadata" jsonb,
  "workflow_run_id" text,
  "body_purge_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "a2a_task_owner_idx" ON "a2a_task" ("workspace_id", "tenant", "updated_at" DESC);
--> statement-breakpoint
CREATE INDEX "a2a_task_purge_idx" ON "a2a_task" ("body_purge_at");
