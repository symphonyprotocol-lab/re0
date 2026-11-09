CREATE TABLE "provider_pricing" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"rates" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_pricing_singleton_check" CHECK ("provider_pricing"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "provider_pricing" ADD CONSTRAINT "provider_pricing_updated_by_administrator_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."administrator"("id") ON DELETE no action ON UPDATE no action;