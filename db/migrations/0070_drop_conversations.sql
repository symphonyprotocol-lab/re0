-- open-chat-holds guard begin
/*
 * PR B: the conversations go. A chat hold still open names a question whose
 * credits are held; dropping its message would leave it with nothing to
 * settle against, so the migration -- and with it the whole build, every
 * migration of the deploy being one transaction -- stops here instead.
 * Nothing creates chat holds once the chat routes are gone (this release),
 * and until then the previous release's release-chat-holds cron gives back
 * every hold older than CHAT_HOLD_STALE_MS every five minutes; a build that
 * stops here can simply be retried a few minutes later.
 */
DO $$
DECLARE
  open_holds integer;
BEGIN
  SELECT count(*) INTO open_holds FROM "credit_hold" WHERE "kind" = 'chat' AND "status" = 'held';
  IF open_holds > 0 THEN
    RAISE EXCEPTION 'migration 0070: % chat hold(s) still open; let the release-chat-holds cron release them, then deploy again', open_holds;
  END IF;
END $$;
-- open-chat-holds guard end
--> statement-breakpoint
-- legacy-stats refresh begin
/*
 * The frozen conversation figures once more, as 0066 and 0067 froze them
 * (the same statements): the release before this one still answered the
 * old chat routes, so a question asked through a page left open since then
 * counts too. Re-runnable: each overwrites what it wrote.
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
--> statement-breakpoint
UPDATE "api_key" k SET "legacy_questions" = u.questions, "legacy_spent" = u.spent
FROM (
  SELECT q.api_key_id AS key_id, count(DISTINCT q.id)::int AS questions, coalesce(sum(r.cost_credits), 0)::int AS spent
  FROM "message" q LEFT JOIN "message" r ON r.request_id = q.id AND r.role = 'ree'
  WHERE q.api_key_id IS NOT NULL AND q.role = 'user'
  GROUP BY q.api_key_id
) u
WHERE k.id = u.key_id;
-- legacy-stats refresh end
--> statement-breakpoint
CREATE TABLE "payout_trace_legacy" (
	"reply_id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"ree_id" uuid,
	"asker_id" uuid NOT NULL,
	"asked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- payout-trace snapshot begin
/*
 * Payout review traces each earned credit to whoever paid it
 * (payout-funding.ts): a conversation answer's `query_fee_earned` entry
 * names the reply, whose question names the conversation and so the asker.
 * Kept here, per reply that earned anything, before the messages go.
 * Re-runnable: a reply already kept is left alone.
 */
INSERT INTO "payout_trace_legacy" ("reply_id", "request_id", "ree_id", "asker_id", "asked_at")
SELECT m.id, m.request_id, m.ree_id, c.user_id, q.created_at
FROM "message" m
JOIN "message" q ON q.id = m.request_id
JOIN "conversation" c ON c.id = q.conversation_id
WHERE m.role = 'ree'
  AND m.id IN (SELECT e.ref_id FROM "credit_entry" e WHERE e.reason = 'query_fee_earned' AND e.ref_id IS NOT NULL)
ON CONFLICT ("reply_id") DO NOTHING;
-- payout-trace snapshot end
--> statement-breakpoint
-- trashed-public-qa purge begin
/*
 * A public answer published from a conversation, and the post copied from
 * it, showed only while that conversation was out of the trash, and purging
 * the conversation deleted them. Those whose conversation is in the trash
 * now are deleted as the purge would have; every other one stays, a public
 * post like any other, its asker as anonymous as before.
 */
DELETE FROM "post" p
USING "message" m, "conversation" c
WHERE p.source = 'conversation' AND m.id = p.message_id AND c.id = m.conversation_id AND c.deleted_at IS NOT NULL;
--> statement-breakpoint
DELETE FROM "ree_public_qa" q
USING "message" m, "conversation" c
WHERE m.id = q.message_id AND c.id = m.conversation_id AND c.deleted_at IS NOT NULL;
-- trashed-public-qa purge end
--> statement-breakpoint
ALTER TABLE "answer_check" DROP CONSTRAINT "answer_check_message_id_message_id_fk";--> statement-breakpoint
ALTER TABLE "post" DROP CONSTRAINT "post_message_id_message_id_fk";--> statement-breakpoint
ALTER TABLE "ree_public_qa" DROP CONSTRAINT "ree_public_qa_message_id_message_id_fk";--> statement-breakpoint
ALTER TABLE "ree_share_event" DROP CONSTRAINT "ree_share_event_conversation_id_conversation_id_fk";--> statement-breakpoint
DROP INDEX "ree_public_qa_message_key";--> statement-breakpoint
DROP INDEX "ree_share_event_conversation_key";--> statement-breakpoint
ALTER TABLE "answer_check" DROP COLUMN "message_id";--> statement-breakpoint
ALTER TABLE "post" DROP COLUMN "message_id";--> statement-breakpoint
ALTER TABLE "ree_public_qa" DROP COLUMN "message_id";--> statement-breakpoint
ALTER TABLE "ree_share_event" DROP COLUMN "conversation_id";--> statement-breakpoint
DROP TABLE "synthesis_feedback";--> statement-breakpoint
DROP TABLE "synthesis";--> statement-breakpoint
DROP TABLE "ree_feedback";--> statement-breakpoint
DROP TABLE "conversation_ree";--> statement-breakpoint
DROP TABLE "message";--> statement-breakpoint
DROP TABLE "conversation";
