ALTER TABLE "paddle_checkout" ADD COLUMN "release_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "paddle_checkout" ADD COLUMN "release_tried_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paddle_checkout" ADD COLUMN "release_error" text;