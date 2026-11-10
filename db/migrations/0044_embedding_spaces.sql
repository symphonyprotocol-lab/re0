-- Embedding spaces (lib/services/embedding-space.ts): every stored vector is
-- tagged with the space it belongs to, so switching the embedding model is a
-- one-row flip instead of a rewrite of every chunk. Catalog-only changes on
-- the big tables: nullable columns without a default and a dropped NOT NULL
-- take a brief lock and touch no rows. Existing vectors stay untagged, which
-- reads as the base space; nothing is backfilled.
ALTER TABLE "chunk" ALTER COLUMN "embedding" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "embedding_space" uuid;--> statement-breakpoint
ALTER TABLE "chunk" ADD COLUMN "embedding_next_space" uuid;--> statement-breakpoint
ALTER TABLE "model_config" ADD COLUMN "embedding_space" uuid;--> statement-breakpoint
ALTER TABLE "ree_profile_vector" ADD COLUMN "embedding_space" uuid;--> statement-breakpoint
-- reembed_job holds a handful of rows: earlier jobs get their own id as space.
ALTER TABLE "reembed_job" ADD COLUMN "space" uuid;--> statement-breakpoint
UPDATE "reembed_job" SET "space" = "id" WHERE "space" IS NULL;--> statement-breakpoint
ALTER TABLE "reembed_job" ALTER COLUMN "space" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "reembed_job" ADD COLUMN "arrived" integer DEFAULT 0 NOT NULL;
