ALTER TABLE "anonymous_chat_quota" DROP CONSTRAINT "anonymous_chat_quota_rounds_check";--> statement-breakpoint
ALTER TABLE "anonymous_chat_quota" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Rows from before attempts were counted: every round taken was an attempt.
UPDATE "anonymous_chat_quota" SET "attempts" = "rounds";--> statement-breakpoint
ALTER TABLE "anonymous_chat_quota" ADD CONSTRAINT "anonymous_chat_quota_rounds_check" CHECK (rounds >= 0 and attempts >= rounds);