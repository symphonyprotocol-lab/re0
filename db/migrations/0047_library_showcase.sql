-- A library shared as a standalone page: a company or product introduction
-- on top, the library's own Q&A under it. lib/domain/showcase.ts.
--
-- One row per library. The page answers through an internal site key (the
-- widget's own key row, marked `kind = 'showcase'`), so the question path,
-- the exchange log, the FAQ and the quota brakes are the widget's, unchanged.
-- `content` is the owner's copy for the top of the page, as a document the
-- domain validates; `starter_questions` the chips under it.

DO $$ BEGIN
  CREATE TYPE "site_key_kind" AS ENUM ('embed', 'showcase');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "showcase_kind" AS ENUM ('company', 'product');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "showcase_status" AS ENUM ('draft', 'published', 'disabled', 'taken_down');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "showcase_access" AS ENUM ('public', 'unlisted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "site_key" ADD COLUMN IF NOT EXISTS "kind" "site_key_kind" NOT NULL DEFAULT 'embed';
--> statement-breakpoint
ALTER TABLE "widget_exchange" ADD COLUMN IF NOT EXISTS "feedback" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "library_showcase" (
  "id" uuid PRIMARY KEY,
  "library_id" uuid NOT NULL REFERENCES "library"("id"),
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id"),
  "site_key_id" uuid NOT NULL REFERENCES "site_key"("id"),
  "kind" "showcase_kind" NOT NULL,
  "slug" text NOT NULL,
  "previous_slug" text,
  "status" "showcase_status" NOT NULL DEFAULT 'draft',
  "access" "showcase_access" NOT NULL DEFAULT 'public',
  "locale" text NOT NULL DEFAULT 'en',
  "content" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "starter_questions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "logo_key" text,
  "screenshot_key" text,
  "accent" text NOT NULL,
  "show_branding" boolean NOT NULL DEFAULT true,
  "generated_at" timestamp with time zone,
  "published_at" timestamp with time zone,
  "disabled_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "library_showcase_library_uq" ON "library_showcase" ("library_id") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "library_showcase_slug_uq" ON "library_showcase" ("slug") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_showcase_previous_slug_idx" ON "library_showcase" ("previous_slug") WHERE "previous_slug" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_showcase_workspace_idx" ON "library_showcase" ("workspace_id");
--> statement-breakpoint
-- Views, questions and CTA clicks per page and UTC day. Counters, not an
-- audit fact: written off the request path, read on the library's page.
CREATE TABLE IF NOT EXISTS "library_showcase_daily" (
  "showcase_id" uuid NOT NULL REFERENCES "library_showcase"("id") ON DELETE CASCADE,
  "day" date NOT NULL,
  "views" integer NOT NULL DEFAULT 0,
  "questions" integer NOT NULL DEFAULT 0,
  "cta_clicks" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("showcase_id", "day")
);
