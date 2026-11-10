DROP INDEX IF EXISTS "chunk_embedding_idx";--> statement-breakpoint
-- Storage billing starts at its release: knowledge that already exists is billed from now, not from its creation.
UPDATE "knowledge" SET "storage_billed_at" = now() WHERE "storage_billed_at" IS NULL;
