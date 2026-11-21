CREATE TABLE "model_chain" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"audience" text NOT NULL,
	"model_config_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_chain_kind_check" CHECK (kind in ('generation', 'embedding', 'transcription', 'speech')),
	CONSTRAINT "model_chain_audience_check" CHECK (audience in ('free', 'plan', 'all')),
	CONSTRAINT "model_chain_audience_kind_check" CHECK ((kind = 'generation') = (audience in ('free', 'plan'))),
	CONSTRAINT "model_chain_position_check" CHECK (position >= 0)
);
--> statement-breakpoint
CREATE TABLE "model_health" (
	"model_config_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'ok' NOT NULL,
	"reason" text,
	"cooling_until" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_failure_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error_code" text,
	"last_probe_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_health_state_check" CHECK (state in ('ok', 'cooling')),
	CONSTRAINT "model_health_reason_check" CHECK (reason is null or reason in ('quota', 'rate_limit', 'server', 'timeout', 'auth', 'model_missing'))
);
--> statement-breakpoint
CREATE TABLE "model_health_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_config_id" uuid NOT NULL,
	"event" text NOT NULL,
	"reason" text,
	"cooling_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_health_event_event_check" CHECK (event in ('cooling', 'recovered', 'manual_clear'))
);
--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN "chain_position" integer;--> statement-breakpoint
ALTER TABLE "model_chain" ADD CONSTRAINT "model_chain_model_config_id_model_config_id_fk" FOREIGN KEY ("model_config_id") REFERENCES "public"."model_config"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_health" ADD CONSTRAINT "model_health_model_config_id_model_config_id_fk" FOREIGN KEY ("model_config_id") REFERENCES "public"."model_config"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_chain_entry_key" ON "model_chain" USING btree ("kind","audience","model_config_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_chain_position_key" ON "model_chain" USING btree ("kind","audience","position");--> statement-breakpoint
CREATE INDEX "model_health_event_time_idx" ON "model_health_event" USING btree ("created_at");--> statement-breakpoint
INSERT INTO "model_chain" ("kind", "audience", "model_config_id", "position", "updated_by", "updated_at")
  SELECT "kind", CASE WHEN "kind" = 'generation' THEN 'free' ELSE 'all' END, "id", 0, "updated_by", now()
  FROM "model_config" WHERE "enabled"
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "model_chain" ("kind", "audience", "model_config_id", "position", "updated_by", "updated_at")
  SELECT "kind", 'plan', "id", 0, "updated_by", now()
  FROM "model_config" WHERE "enabled_plan" AND "kind" = 'generation'
  ON CONFLICT DO NOTHING;
