-- The four models an installation runs become configuration it holds, not
-- configuration it was deployed with. architecture.md 9.1, 9.2, 9.5, 15.3.
--
-- Before this, the embedding model, the reranker and every generation model
-- read their endpoint and credential out of the environment, so changing any
-- of them meant a redeploy -- and the console could show an operator that
-- reranking was off without offering them any way to turn it on.
--
-- Three parts:
--
-- 1. `provider_model_config` holds the two retrieval models. One row per kind,
--    newest in force, append-only like `retrieval_config`: what an
--    installation is indexing with is part of what its retrieval *is*, and
--    the history of when it changed is the table.
--
-- 2. `llm_config.api_key_env` becomes `api_key_cipher`. The registry used to
--    name an environment variable to read; it now carries the credential
--    itself, sealed with `CREDENTIAL_ENCRYPTION_KEY`. Existing rows cannot be
--    converted -- this migration cannot read the deployment's environment, and
--    would not put a plaintext key in a migration file if it could -- so they
--    land with a null cipher, which reads as "no credential" and refuses the
--    call rather than falling back to somebody else's key. Every entry's key
--    has to be entered once in the console after this runs.
--
-- 3. `library_version.embedding_dimensions` freezes the width a version was
--    built at, beside the model name it already froze. The vector columns stay
--    1536 wide and a narrower model's vectors are zero-padded into them, so
--    the stored width no longer says which space a version lives in. Existing
--    versions were all built by a 1536-dimensional model, which is the default.

CREATE TYPE "model_kind" AS ENUM('embedding', 'rerank');

CREATE TABLE IF NOT EXISTS "provider_model_config" (
  "id" uuid PRIMARY KEY,
  "kind" "model_kind" NOT NULL,
  "label" text NOT NULL,
  "base_url" text NOT NULL,
  "model" text NOT NULL,
  "api_key_cipher" text,
  "dimensions" integer,
  "timeout_ms" integer NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- A rerank row carrying a width would describe a model that does not exist,
  -- and an embedding row without one cannot be padded into the column.
  CONSTRAINT "provider_model_config_dimensions"
    CHECK (("kind" = 'embedding') = ("dimensions" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "provider_model_config_kind_time_idx"
  ON "provider_model_config" ("kind", "created_at" DESC);

ALTER TABLE "llm_config" DROP COLUMN IF EXISTS "api_key_env";
ALTER TABLE "llm_config" ADD COLUMN IF NOT EXISTS "api_key_cipher" text;

ALTER TABLE "library_version"
  ADD COLUMN IF NOT EXISTS "embedding_dimensions" integer DEFAULT 1536 NOT NULL;
