-- Per-answer billing (2026-11-19): posting no longer holds a fee. A post fee still held from the old model (local and test databases only; production never had posts) is given back exactly as releaseHold does: a post_refund entry, the allocations returned to their grants, the hold released.
INSERT INTO "credit_entry" ("user_id", "delta", "reason", "ref_id", "ree_id", "note", "allocations") SELECT h."user_id", h."amount", 'post_refund', h."ref_id", h."ree_id", 'post', h."allocations" FROM "credit_hold" h JOIN "post" p ON p."hold_id" = h."id" WHERE h."status" = 'held';--> statement-breakpoint
UPDATE "credit_grant" g SET "remaining" = g."remaining" + a."amount" FROM (SELECT (e->>'grantId')::uuid AS "grant_id", sum((e->>'amount')::bigint) AS "amount" FROM "credit_hold" h JOIN "post" p ON p."hold_id" = h."id" CROSS JOIN jsonb_array_elements(h."allocations") e WHERE h."status" = 'held' GROUP BY 1) a WHERE g."id" = a."grant_id";--> statement-breakpoint
UPDATE "credit_hold" SET "status" = 'released', "closed_at" = now() WHERE "status" = 'held' AND "id" IN (SELECT "hold_id" FROM "post" WHERE "hold_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "post" DROP CONSTRAINT "post_charge_check";--> statement-breakpoint
DROP INDEX "post_free_day_idx";--> statement-breakpoint
ALTER TABLE "post" DROP COLUMN "charge";--> statement-breakpoint
ALTER TABLE "post" DROP COLUMN "hold_id";--> statement-breakpoint
ALTER TABLE "post" DROP COLUMN "free_day";