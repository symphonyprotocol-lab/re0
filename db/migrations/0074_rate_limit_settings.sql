CREATE TABLE "rate_limit_exemption" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_setting" (
	"name" text PRIMARY KEY NOT NULL,
	"per_minute" integer NOT NULL,
	"per_hour" integer NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_setting_minute_check" CHECK (per_minute between 1 and 1000000),
	CONSTRAINT "rate_limit_setting_hour_check" CHECK (per_hour between 1 and 1000000)
);
--> statement-breakpoint
ALTER TABLE "rate_limit_exemption" ADD CONSTRAINT "rate_limit_exemption_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_exemption" ADD CONSTRAINT "rate_limit_exemption_created_by_administrator_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."administrator"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_setting" ADD CONSTRAINT "rate_limit_setting_updated_by_administrator_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."administrator"("id") ON DELETE set null ON UPDATE no action;