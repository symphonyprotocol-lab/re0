-- Large sources finish instead of being killed (lib/services/knowledge.ts):
-- a run stages its embedded passages in `knowledge_stage` slice by slice, so
-- a run the platform killed is resumed by the next attempt instead of
-- embedding (and billing) everything again; and each processing run beats
-- `knowledge_cost_run.heartbeat_at`, so a dead run is noticed in minutes, not
-- after a fixed quarter of an hour. Both are new: no rows are touched.
CREATE TABLE "knowledge_stage" (
	"knowledge_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"digest" text NOT NULL,
	"config_id" text NOT NULL,
	"content" text NOT NULL,
	"locator" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_stage_knowledge_id_ordinal_pk" PRIMARY KEY("knowledge_id","ordinal")
);
--> statement-breakpoint
ALTER TABLE "knowledge_cost_run" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_stage" ADD CONSTRAINT "knowledge_stage_knowledge_id_knowledge_id_fk" FOREIGN KEY ("knowledge_id") REFERENCES "public"."knowledge"("id") ON DELETE cascade ON UPDATE no action;