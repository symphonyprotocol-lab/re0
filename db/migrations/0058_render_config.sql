-- The rendering fallback becomes configuration the console holds
-- (2026-10-25). architecture.md 8.2, 15.3.
--
-- Website builds hand a page to a rendering service when the site refuses a
-- plain fetch or serves a script shell. Until now the provider and its one
-- key were deployment variables (`RENDER_PROVIDER*`), so a key that ran out
-- of quota stopped every such build until somebody redeployed with another.
--
-- 1. `render_config`: the provider in force -- Firecrawl, AnySearch or Jina --
--    and an optional self-hosted base URL. Append-only, newest row in force,
--    like `provider_model_config`. No row means the deployment variables.
--
-- 2. `render_provider_key`: each provider's ordered pool of sealed keys. A
--    build tries them in order and moves on from one the provider calls spent
--    (402) or refused (401), recording that here so later builds try it last.
--    lib/infrastructure/connectors/render.ts, manage-render-config.ts.

CREATE TYPE "render_provider" AS ENUM('firecrawl', 'anysearch', 'jina');

CREATE TABLE IF NOT EXISTS "render_config" (
  "id" uuid PRIMARY KEY,
  "provider" "render_provider" NOT NULL,
  "base_url" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "render_config_time_idx" ON "render_config" ("created_at" DESC);

CREATE TABLE IF NOT EXISTS "render_provider_key" (
  "id" uuid PRIMARY KEY,
  "provider" "render_provider" NOT NULL,
  "label" text NOT NULL,
  "api_key_cipher" text NOT NULL,
  "position" integer NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "failure" text,
  "failure_detail" text,
  "failed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "render_provider_key_failure"
    CHECK ("failure" IS NULL OR "failure" IN ('exhausted', 'rejected'))
);
CREATE INDEX IF NOT EXISTS "render_provider_key_order_idx"
  ON "render_provider_key" ("provider", "position");
