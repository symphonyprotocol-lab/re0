-- Per-answer billing (2026-11-19): posting no longer holds a fee. A post fee still held from the old model (local and test databases only; production never had posts) is given back exactly as releaseHold does -- the hold released, a post_refund entry, the allocations returned to their grants -- in one statement, so running it again finds nothing held and does nothing.
WITH "retired" AS (UPDATE "credit_hold" SET "status" = 'released', "closed_at" = now() WHERE "status" = 'held' AND "id" IN (SELECT "hold_id" FROM "post" WHERE "hold_id" IS NOT NULL) RETURNING "id", "user_id", "amount", "ref_id", "ree_id", "allocations"), "entries" AS (INSERT INTO "credit_entry" ("user_id", "delta", "reason", "ref_id", "ree_id", "note", "allocations") SELECT "user_id", "amount", 'post_refund', "ref_id", "ree_id", 'post', "allocations" FROM "retired" RETURNING 1) UPDATE "credit_grant" g SET "remaining" = g."remaining" + a."amount" FROM (SELECT (e->>'grantId')::uuid AS "grant_id", sum((e->>'amount')::bigint) AS "amount" FROM "retired" CROSS JOIN jsonb_array_elements("retired"."allocations") e GROUP BY 1) a WHERE g."id" = a."grant_id";--> statement-breakpoint
ALTER TABLE "post" DROP CONSTRAINT "post_charge_check";--> statement-breakpoint
DROP INDEX "post_free_day_idx";--> statement-breakpoint
ALTER TABLE "post" DROP COLUMN "charge";--> statement-breakpoint
ALTER TABLE "post" DROP COLUMN "hold_id";--> statement-breakpoint
ALTER TABLE "post" DROP COLUMN "free_day";--> statement-breakpoint
ALTER TABLE "post_answer" ADD COLUMN "agreements" integer DEFAULT 0 NOT NULL;
