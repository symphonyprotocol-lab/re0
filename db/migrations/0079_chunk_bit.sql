CREATE TABLE "chunk_bit" (
	"chunk_id" uuid NOT NULL,
	"slot" smallint NOT NULL,
	"space" uuid NOT NULL,
	"ree_id" uuid NOT NULL,
	"knowledge_id" uuid NOT NULL,
	"bits" bit(1536) NOT NULL,
	CONSTRAINT "chunk_bit_chunk_id_slot_pk" PRIMARY KEY("chunk_id","slot"),
	CONSTRAINT "chunk_bit_slot_check" CHECK ("chunk_bit"."slot" in (0, 1))
);
--> statement-breakpoint
CREATE TABLE "chunk_bit_backfill" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "chunk_bit_backfill_single" CHECK ("chunk_bit_backfill"."id")
);
--> statement-breakpoint
ALTER TABLE "chunk_bit" ADD CONSTRAINT "chunk_bit_chunk_id_chunk_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunk"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunk_bit_ree_idx" ON "chunk_bit" USING btree ("ree_id","space");--> statement-breakpoint
-- Keeps chunk_bit in step with every write of a chunk vector slot (db/schema.ts `chunkBit`): a slot with a vector in a space has its row, a slot without one has none. Only a slot whose vector, space tag, Ree or source changed is rewritten.
CREATE FUNCTION "chunk_bit_sync"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' OR NEW.embedding IS DISTINCT FROM OLD.embedding OR NEW.embedding_space IS DISTINCT FROM OLD.embedding_space
		OR NEW.ree_id IS DISTINCT FROM OLD.ree_id OR NEW.knowledge_id IS DISTINCT FROM OLD.knowledge_id THEN
		IF NEW.embedding IS NULL THEN
			DELETE FROM "chunk_bit" WHERE "chunk_id" = NEW.id AND "slot" = 0;
		ELSE
			INSERT INTO "chunk_bit" ("chunk_id", "slot", "space", "ree_id", "knowledge_id", "bits")
			VALUES (NEW.id, 0, coalesce(NEW.embedding_space, '00000000-0000-0000-0000-000000000000'::uuid), NEW.ree_id, NEW.knowledge_id, binary_quantize(NEW.embedding)::bit(1536))
			ON CONFLICT ("chunk_id", "slot") DO UPDATE SET "space" = excluded."space", "ree_id" = excluded."ree_id", "knowledge_id" = excluded."knowledge_id", "bits" = excluded."bits";
		END IF;
	END IF;
	IF TG_OP = 'INSERT' OR NEW.embedding_next IS DISTINCT FROM OLD.embedding_next OR NEW.embedding_next_space IS DISTINCT FROM OLD.embedding_next_space
		OR NEW.ree_id IS DISTINCT FROM OLD.ree_id OR NEW.knowledge_id IS DISTINCT FROM OLD.knowledge_id THEN
		-- The second slot has no space without its tag (explore.ts SLOTS).
		IF NEW.embedding_next IS NULL OR NEW.embedding_next_space IS NULL THEN
			DELETE FROM "chunk_bit" WHERE "chunk_id" = NEW.id AND "slot" = 1;
		ELSE
			INSERT INTO "chunk_bit" ("chunk_id", "slot", "space", "ree_id", "knowledge_id", "bits")
			VALUES (NEW.id, 1, NEW.embedding_next_space, NEW.ree_id, NEW.knowledge_id, binary_quantize(NEW.embedding_next)::bit(1536))
			ON CONFLICT ("chunk_id", "slot") DO UPDATE SET "space" = excluded."space", "ree_id" = excluded."ree_id", "knowledge_id" = excluded."knowledge_id", "bits" = excluded."bits";
		END IF;
	END IF;
	RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "chunk_bit_sync" AFTER INSERT OR UPDATE OF "embedding", "embedding_space", "embedding_next", "embedding_next_space", "ree_id", "knowledge_id" ON "chunk" FOR EACH ROW EXECUTE FUNCTION "chunk_bit_sync"();
--> statement-breakpoint
-- Rows written before the trigger are filled by `db:cutover -- chunk-bits`, which sets completed_at; a database without a chunk vector has none to fill.
INSERT INTO "chunk_bit_backfill" ("id", "completed_at")
SELECT true, CASE WHEN EXISTS (SELECT 1 FROM "chunk" WHERE "embedding" IS NOT NULL OR "embedding_next" IS NOT NULL) THEN NULL ELSE now() END;
