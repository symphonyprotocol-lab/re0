CREATE TABLE "video_pricing" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"script_credits" integer NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_pricing_singleton_check" CHECK (id = 1),
	CONSTRAINT "video_pricing_script_credits_check" CHECK (script_credits between 1 and 100000000)
);
--> statement-breakpoint
ALTER TABLE "video_pricing" ADD CONSTRAINT "video_pricing_updated_by_administrator_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."administrator"("id") ON DELETE no action ON UPDATE no action;