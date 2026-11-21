ALTER TABLE "message" ADD COLUMN "copied_from_post" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "summary_rewrites" integer DEFAULT 0 NOT NULL;