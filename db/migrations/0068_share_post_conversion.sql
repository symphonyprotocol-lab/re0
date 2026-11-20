ALTER TABLE "ree_share_event" DROP CONSTRAINT "ree_share_event_kind_check";--> statement-breakpoint
ALTER TABLE "ree_share_event" ADD COLUMN "post_id" uuid;--> statement-breakpoint
ALTER TABLE "ree_share_event" ADD CONSTRAINT "ree_share_event_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ree_share_event_post_key" ON "ree_share_event" USING btree ("post_id","ree_id") WHERE kind = 'post';--> statement-breakpoint
ALTER TABLE "ree_share_event" ADD CONSTRAINT "ree_share_event_kind_check" CHECK (kind in ('visit', 'conversation', 'post'));