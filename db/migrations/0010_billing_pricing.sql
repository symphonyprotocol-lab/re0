CREATE TABLE "billing_price" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" text NOT NULL,
	"kind" text NOT NULL,
	"price_minor" integer NOT NULL,
	"paddle_price_id" text NOT NULL,
	"promotion_price_minor" integer,
	"promotion_starts_at" timestamp with time zone,
	"promotion_ends_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_price_environment_check" CHECK (environment in ('sandbox', 'production')),
	CONSTRAINT "billing_price_kind_check" CHECK (kind in ('plan', 'pack')),
	CONSTRAINT "billing_price_amount_check" CHECK (price_minor between 1 and 100000000),
	CONSTRAINT "billing_price_promotion_check" CHECK ((promotion_price_minor is null and promotion_starts_at is null and promotion_ends_at is null) or (promotion_price_minor is not null and promotion_starts_at is not null and promotion_ends_at is not null and promotion_price_minor > 0 and promotion_price_minor < price_minor and promotion_starts_at < promotion_ends_at))
);
--> statement-breakpoint
ALTER TABLE "paddle_checkout" ADD COLUMN "price_key" text;--> statement-breakpoint
ALTER TABLE "paddle_checkout" ADD COLUMN "unit_price_minor" integer;--> statement-breakpoint
ALTER TABLE "paddle_checkout" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_price" ADD CONSTRAINT "billing_price_updated_by_administrator_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."administrator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_price_current_key" ON "billing_price" USING btree ("environment","kind") WHERE enabled;--> statement-breakpoint
CREATE INDEX "billing_price_paddle_idx" ON "billing_price" USING btree ("paddle_price_id");