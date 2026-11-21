ALTER TABLE "notice" DROP CONSTRAINT "notice_kind_check";--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "legacy_questions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "legacy_spent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "post_followup" ADD COLUMN "api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_api_key_id_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_followup" ADD CONSTRAINT "post_followup_api_key_id_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_key"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_published_copy_idx" ON "post" USING btree ("published_copy_id") WHERE published_copy_id is not null;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_kind_check" CHECK (kind in ('takedown', 'restore', 'credits_adjust', 'kyc', 'payout', 'role', 'verification', 'post_answered', 'post_quoted', 'post_paid_requests', 'post_followup', 'followup_answered', 'chats_removal'));--> statement-breakpoint
-- chats-removal-notice backfill begin
/*
 * Private questions are private posts now (私密提问): everyone who still has
 * a conversation with something in it is told, once, that the old
 * conversations were deleted with the redesign: 0070 (PR B) drops them in
 * the same release, with no window to copy them first. The page words it
 * from the kind; nothing else is needed.
 */
INSERT INTO "notice" ("user_id", "kind", "params", "ref_id")
SELECT u.id, 'chats_removal', '{}'::jsonb, NULL
FROM "user" u
WHERE EXISTS (
  SELECT 1 FROM "conversation" c
  WHERE c.user_id = u.id AND c.kind = 'normal' AND c.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM "message" m WHERE m.conversation_id = c.id)
)
AND NOT EXISTS (SELECT 1 FROM "notice" n WHERE n.user_id = u.id AND n.kind = 'chats_removal');
-- chats-removal-notice backfill end
--> statement-breakpoint
-- api-key-usage backfill begin
/*
 * What each API key asked and spent through MCP conversations, as api-keys.ts
 * `usageOf` counted it until now (questions; the credits their replies were
 * charged), frozen before PR B deletes them. Re-runnable: it overwrites.
 */
UPDATE "api_key" k SET "legacy_questions" = u.questions, "legacy_spent" = u.spent
FROM (
  SELECT q.api_key_id AS key_id, count(DISTINCT q.id)::int AS questions, coalesce(sum(r.cost_credits), 0)::int AS spent
  FROM "message" q LEFT JOIN "message" r ON r.request_id = q.id AND r.role = 'ree'
  WHERE q.api_key_id IS NOT NULL AND q.role = 'user'
  GROUP BY q.api_key_id
) u
WHERE k.id = u.key_id;
-- api-key-usage backfill end
