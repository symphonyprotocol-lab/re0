-- A resumed knowledge run reads what the first attempt extracted instead of
-- fetching, downloading or transcribing the source again
-- (lib/services/knowledge.ts): one row per source while it is processed,
-- removed when it is ready or fails. New table; no rows are touched.
CREATE TABLE "knowledge_extract" (
	"knowledge_id" uuid PRIMARY KEY NOT NULL,
	"extracted" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_extract" ADD CONSTRAINT "knowledge_extract_knowledge_id_knowledge_id_fk" FOREIGN KEY ("knowledge_id") REFERENCES "public"."knowledge"("id") ON DELETE cascade ON UPDATE no action;