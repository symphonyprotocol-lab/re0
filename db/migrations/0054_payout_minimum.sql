CREATE TABLE "payout_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"min_credits" integer NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_settings_singleton_check" CHECK (id = 1),
	CONSTRAINT "payout_settings_min_check" CHECK (min_credits between 1 and 100000000)
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "payout_min_credits" integer;--> statement-breakpoint
ALTER TABLE "payout_settings" ADD CONSTRAINT "payout_settings_updated_by_administrator_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."administrator"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_payout_min_check" CHECK (payout_min_credits is null or payout_min_credits between 1 and 100000000) NOT VALID;--> statement-breakpoint
ALTER TABLE "user" VALIDATE CONSTRAINT "user_payout_min_check";
