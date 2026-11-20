-- Site-wide traffic (console 「流量」): raw page views from the root layout's beacon, kept 90 days, and the daily rollup the cron /api/cron/traffic writes for finished UTC+8 days. No IP, no user agent; of the referrer only its host.
CREATE TABLE "site_traffic_day" (
	"day" date NOT NULL,
	"source" text NOT NULL,
	"page_kind" text NOT NULL,
	"views" integer NOT NULL,
	"visitors" integer NOT NULL,
	"visits" integer NOT NULL,
	CONSTRAINT "site_traffic_day_day_source_page_kind_pk" PRIMARY KEY("day","source","page_kind")
);
--> statement-breakpoint
CREATE TABLE "site_traffic_landing" (
	"day" date NOT NULL,
	"source" text NOT NULL,
	"path" text NOT NULL,
	"page_kind" text NOT NULL,
	"visits" integer NOT NULL,
	CONSTRAINT "site_traffic_landing_day_source_path_pk" PRIMARY KEY("day","source","path")
);
--> statement-breakpoint
CREATE TABLE "site_traffic_rollup" (
	"day" date PRIMARY KEY NOT NULL,
	"rolled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_view" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visitor_id" text NOT NULL,
	"user_id" uuid,
	"path" text NOT NULL,
	"page_kind" text NOT NULL,
	"landing" boolean NOT NULL,
	"source" text NOT NULL,
	"referrer_host" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_view_page_kind_check" CHECK (page_kind in ('home', 'ree', 'share', 'explore', 'post', 'pricing', 'about', 'legal', 'login', 'workspace', 'other')),
	CONSTRAINT "site_view_path_check" CHECK (char_length(path) between 1 and 300),
	CONSTRAINT "site_view_source_check" CHECK (char_length(source) between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "site_view" ADD CONSTRAINT "site_view_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_view_visitor_idx" ON "site_view" USING btree ("visitor_id","created_at");--> statement-breakpoint
CREATE INDEX "site_view_created_idx" ON "site_view" USING btree ("created_at");