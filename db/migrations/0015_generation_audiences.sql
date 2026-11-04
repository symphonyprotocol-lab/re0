ALTER TABLE "model_config" ADD COLUMN "enabled_plan" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "model_config_one_enabled_plan_key" ON "model_config" USING btree ("kind") WHERE enabled_plan;--> statement-breakpoint
ALTER TABLE "model_config" ADD CONSTRAINT "model_config_enabled_plan_check" CHECK (not enabled_plan or kind = 'generation');--> statement-breakpoint
-- Preserve the live generation model for both audiences until explicitly switched.
UPDATE "model_config" SET "enabled_plan" = true WHERE "kind" = 'generation' AND "enabled" = true;
