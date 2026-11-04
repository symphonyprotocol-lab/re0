ALTER TABLE "model_call" ADD COLUMN "config_name" text;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN "audience" text;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN "status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN "usage_known" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN "endpoint" text;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN "cost_usd" text;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN "cost_basis" text DEFAULT 'unresolved' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN "rate" jsonb;--> statement-breakpoint
ALTER TABLE "model_call" ADD COLUMN "price_revision" text;--> statement-breakpoint
CREATE INDEX "model_call_generation_time_idx" ON "model_call" USING btree ("created_at","id") WHERE kind = 'generation';--> statement-breakpoint
ALTER TABLE "model_call" ADD CONSTRAINT "model_call_status_check" CHECK (status in ('unknown', 'succeeded', 'failed', 'aborted'));--> statement-breakpoint
ALTER TABLE "model_call" ADD CONSTRAINT "model_call_audience_check" CHECK (audience is null or audience in ('free', 'plan'));--> statement-breakpoint
ALTER TABLE "model_call" ADD CONSTRAINT "model_call_cost_basis_check" CHECK (cost_basis in ('unresolved', 'provider_reported', 'configured_rate', 'estimated'));