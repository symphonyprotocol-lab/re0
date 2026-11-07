ALTER TABLE "ree_share_event" ADD COLUMN "visit_slot" integer;--> statement-breakpoint
UPDATE "ree_share_event" SET "visit_slot" = floor(extract(epoch from "created_at") / 1800)::int WHERE kind = 'visit';--> statement-breakpoint
DELETE FROM "ree_share_event" a USING "ree_share_event" b WHERE a.kind = 'visit' AND b.kind = 'visit' AND a.visitor_id = b.visitor_id AND a.ree_id = b.ree_id AND a.visit_slot = b.visit_slot AND (a.created_at, a.id) > (b.created_at, b.id);--> statement-breakpoint
CREATE UNIQUE INDEX "ree_share_event_visit_key" ON "ree_share_event" USING btree ("visitor_id","ree_id","visit_slot") WHERE kind = 'visit';--> statement-breakpoint
ALTER TABLE "ree_share_event" ADD CONSTRAINT "ree_share_event_visit_slot_check" CHECK ((kind = 'visit') = (visit_slot is not null));
