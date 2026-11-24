CREATE TABLE "limit_ceiling_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" integer NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "limit_ceiling_setting_value_check" CHECK (value between 1 and 100000)
);
--> statement-breakpoint
ALTER TABLE "limit_ceiling_setting" ADD CONSTRAINT "limit_ceiling_setting_updated_by_administrator_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."administrator"("id") ON DELETE set null ON UPDATE no action;