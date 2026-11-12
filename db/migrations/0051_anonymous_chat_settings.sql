CREATE TABLE "anonymous_chat_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"ree_rounds_per_day" integer NOT NULL,
	"platform_rounds_per_day" integer NOT NULL,
	"ip_rounds_per_day" integer NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "anonymous_chat_settings_singleton_check" CHECK (id = 1),
	CONSTRAINT "anonymous_chat_settings_limits_check" CHECK (ree_rounds_per_day between 1 and 10000000 and platform_rounds_per_day between 1 and 10000000 and ip_rounds_per_day between 1 and 10000000)
);
--> statement-breakpoint
ALTER TABLE "anonymous_chat_settings" ADD CONSTRAINT "anonymous_chat_settings_updated_by_administrator_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."administrator"("id") ON DELETE no action ON UPDATE no action;