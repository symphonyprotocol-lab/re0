DROP INDEX "ree_public_idx";--> statement-breakpoint
ALTER TABLE "ree" ADD COLUMN "is_published" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Preserve the visibility of Rees already public before publication became explicit.
UPDATE "ree" SET "is_published" = true WHERE is_public AND moderated_at IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "ree_public_idx" ON "ree" USING btree ("category","created_at") WHERE is_public and is_published and moderated_at is null and deleted_at is null;--> statement-breakpoint
ALTER TABLE "ree" ADD CONSTRAINT "ree_published_public_check" CHECK (not is_published or (is_public and moderated_at is null and deleted_at is null));