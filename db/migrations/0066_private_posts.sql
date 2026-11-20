CREATE TABLE "post_answer_feedback" (
	"answer_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_answer_feedback_answer_id_user_id_pk" PRIMARY KEY("answer_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "ree_legacy_stats" (
	"ree_id" uuid PRIMARY KEY NOT NULL,
	"answers_by_others" integer DEFAULT 0 NOT NULL,
	"helpful" integer DEFAULT 0 NOT NULL,
	"unhelpful" integer DEFAULT 0 NOT NULL,
	"answers_all" integer DEFAULT 0 NOT NULL,
	"questions_by_others" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_legacy_stats" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"external_questions" integer DEFAULT 0 NOT NULL,
	"helpful" integer DEFAULT 0 NOT NULL,
	"unhelpful" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post" DROP CONSTRAINT "post_source_check";--> statement-breakpoint
DROP INDEX "post_feed_idx";--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "published_copy_id" uuid;--> statement-breakpoint
ALTER TABLE "post_answer_feedback" ADD CONSTRAINT "post_answer_feedback_answer_id_post_answer_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."post_answer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_answer_feedback" ADD CONSTRAINT "post_answer_feedback_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ree_legacy_stats" ADD CONSTRAINT "ree_legacy_stats_ree_id_ree_id_fk" FOREIGN KEY ("ree_id") REFERENCES "public"."ree"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_legacy_stats" ADD CONSTRAINT "user_legacy_stats_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_published_copy_id_post_id_fk" FOREIGN KEY ("published_copy_id") REFERENCES "public"."post"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_feed_idx" ON "post" USING btree ("published_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE status = 'published' and deleted_at is null and visibility = 'public';--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_visibility_check" CHECK (visibility in ('public', 'private'));--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_title_check" CHECK (title is null or char_length(title) between 1 and 120);--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_private_source_check" CHECK (source not in ('test', 'api') or visibility = 'private');--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_source_check" CHECK (source in ('post', 'anonymous', 'share', 'conversation', 'seed', 'test', 'api'));--> statement-breakpoint
-- legacy-stats backfill begin
/*
 * What the conversations count today, frozen before PR B deletes them (the
 * readers add the same figures from posts). Each figure is the query that
 * computes it now: explore.ts `answersByOthers` = rank.ts `answers_all`
 * (other people's answered questions, the copied 继续问 exchange left out),
 * ree-feedback.ts `votesByOthers` (other people's 有用 / 没用), and roles.ts
 * `external_questions` (other people's questions, answered or not).
 * Re-runnable: it overwrites what it wrote.
 */
INSERT INTO "ree_legacy_stats" ("ree_id", "answers_by_others", "helpful", "unhelpful", "answers_all", "questions_by_others", "updated_at")
SELECT r.id, coalesce(a.answers, 0), coalesce(v.up, 0), coalesce(v.down, 0), coalesce(a.answers, 0), coalesce(a.asked, 0), now()
FROM "ree" r
LEFT JOIN (
  SELECT m.ree_id, count(*) FILTER (WHERE NOT m.no_answer)::int AS answers, count(*)::int AS asked
  FROM "message" m JOIN "conversation" c ON c.id = m.conversation_id JOIN "ree" o ON o.id = m.ree_id
  WHERE m.role = 'ree' AND NOT m.copied_from_post AND c.user_id <> o.owner_id
  GROUP BY m.ree_id
) a ON a.ree_id = r.id
LEFT JOIN (
  SELECT m.ree_id, count(*) FILTER (WHERE f.vote = 'up')::int AS up, count(*) FILTER (WHERE f.vote = 'down')::int AS down
  FROM "ree_feedback" f JOIN "message" m ON m.id = f.message_id JOIN "ree" o ON o.id = m.ree_id
  WHERE f.user_id <> o.owner_id
  GROUP BY m.ree_id
) v ON v.ree_id = r.id
WHERE a.ree_id IS NOT NULL OR v.ree_id IS NOT NULL
ON CONFLICT ("ree_id") DO UPDATE SET
  "answers_by_others" = excluded."answers_by_others",
  "helpful" = excluded."helpful",
  "unhelpful" = excluded."unhelpful",
  "answers_all" = excluded."answers_all",
  "questions_by_others" = excluded."questions_by_others",
  "updated_at" = excluded."updated_at";
--> statement-breakpoint
/* roles.ts `roleMetrics` counts only the owner's public, live Rees (`countedRees`), as of now. */
INSERT INTO "user_legacy_stats" ("user_id", "external_questions", "helpful", "unhelpful")
SELECT r.owner_id, sum(s.questions_by_others)::int, sum(s.helpful)::int, sum(s.unhelpful)::int
FROM "ree_legacy_stats" s JOIN "ree" r ON r.id = s.ree_id
WHERE r.is_public AND r.is_published AND r.moderated_at IS NULL AND r.deleted_at IS NULL
GROUP BY r.owner_id
ON CONFLICT ("user_id") DO UPDATE SET
  "external_questions" = excluded."external_questions",
  "helpful" = excluded."helpful",
  "unhelpful" = excluded."unhelpful";
-- legacy-stats backfill end
