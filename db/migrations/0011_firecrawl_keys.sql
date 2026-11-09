CREATE TABLE "firecrawl_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"api_key_cipher" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"api_key_tail" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_status" integer,
	"cooldown_until" timestamp with time zone,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "firecrawl_key_name_check" CHECK (char_length(name) between 1 and 80),
	CONSTRAINT "firecrawl_key_use_count_check" CHECK (use_count >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "firecrawl_key_hash_key" ON "firecrawl_key" USING btree ("api_key_hash");--> statement-breakpoint
CREATE INDEX "firecrawl_key_rotation_idx" ON "firecrawl_key" USING btree ("enabled","last_used_at");