-- Crawler and infrastructure traffic (console 「流量」 → 「爬虫 / 基础设施」): per finished UTC+8 day, CDN requests, function invocations and
-- Fast Origin Transfer bytes by crawler family, agent name and route, read from Vercel Observability by /api/cron/crawler-traffic,
-- and the project's Vercel billing charges per billing day and service. No person's user agent is stored.
CREATE TABLE "crawler_route_day" (
	"day" date NOT NULL,
	"route" text NOT NULL,
	"family" text NOT NULL,
	"requests" bigint NOT NULL,
	"invocations" bigint NOT NULL,
	"origin_bytes" bigint NOT NULL,
	CONSTRAINT "crawler_route_day_day_route_family_pk" PRIMARY KEY("day","route","family"),
	CONSTRAINT "crawler_route_day_route_check" CHECK (char_length(route) <= 300)
);
--> statement-breakpoint
CREATE TABLE "crawler_traffic_day" (
	"day" date NOT NULL,
	"family" text NOT NULL,
	"agent" text NOT NULL,
	"requests" bigint NOT NULL,
	"invocations" bigint NOT NULL,
	"origin_bytes" bigint NOT NULL,
	CONSTRAINT "crawler_traffic_day_day_family_agent_pk" PRIMARY KEY("day","family","agent"),
	CONSTRAINT "crawler_traffic_day_family_check" CHECK (family in ('claude', 'openai', 'google', 'bing', 'meta', 'bot', 'human')),
	CONSTRAINT "crawler_traffic_day_agent_check" CHECK (char_length(agent) <= 60)
);
--> statement-breakpoint
CREATE TABLE "crawler_traffic_fetch" (
	"day" date PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "infra_charge_day" (
	"day" date NOT NULL,
	"scope" text NOT NULL,
	"service" text NOT NULL,
	"cost" numeric(18, 8) NOT NULL,
	"quantity" numeric(24, 6) NOT NULL,
	"unit" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "infra_charge_day_day_scope_service_pk" PRIMARY KEY("day","scope","service"),
	CONSTRAINT "infra_charge_day_scope_check" CHECK (scope in ('project', 'team'))
);
