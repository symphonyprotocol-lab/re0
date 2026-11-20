ALTER TABLE "post_ai_answer" ADD COLUMN "review" text;--> statement-breakpoint
ALTER TABLE "post_ai_answer" ADD COLUMN "review_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "post_ai_answer_review_idx" ON "post_ai_answer" USING btree ("answered_at") WHERE review = 'pending';--> statement-breakpoint
ALTER TABLE "post_ai_answer" ADD CONSTRAINT "post_ai_answer_review_check" CHECK (review is null or review in ('pending', 'passed', 'rejected'));--> statement-breakpoint
-- A public post's AI answers written so far were only ever its asker's: reviewed by the posts sweep before anyone else reads them.
UPDATE "post_ai_answer" SET "review" = 'pending' FROM "post" WHERE "post"."id" = "post_ai_answer"."post_id" AND "post"."visibility" = 'public' AND "post_ai_answer"."state" = 'answered';--> statement-breakpoint
-- 继续问 AI follow-ups skipped review while only their asker read them: back to pending, reviewed by the sweep like any public follow-up.
UPDATE "post_followup" SET "status" = 'pending', "moderation_attempts" = 0 FROM "post" WHERE "post"."id" = "post_followup"."post_id" AND "post"."visibility" = 'public' AND "post_followup"."ai_only" = true AND "post_followup"."status" = 'published' AND "post_followup"."deleted_at" IS NULL;--> statement-breakpoint
-- Their posts' counts, from what is published now (a follow-up counts once its review publishes it).
UPDATE "post" SET "followup_count" = (SELECT count(*)::int FROM "post_followup" WHERE "post_followup"."post_id" = "post"."id" AND "post_followup"."status" = 'published' AND "post_followup"."deleted_at" IS NULL) WHERE "post"."id" IN (SELECT "post_id" FROM "post_followup" WHERE "ai_only" = true);
