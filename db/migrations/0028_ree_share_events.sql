CREATE TABLE "ree_share_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ree_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"visitor_id" text NOT NULL,
	"user_id" uuid,
	"conversation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ree_share_event_kind_check" CHECK (kind in ('visit', 'conversation'))
);
--> statement-breakpoint
ALTER TABLE "ree_share_event" ADD CONSTRAINT "ree_share_event_ree_id_ree_id_fk" FOREIGN KEY ("ree_id") REFERENCES "public"."ree"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ree_share_event" ADD CONSTRAINT "ree_share_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ree_share_event" ADD CONSTRAINT "ree_share_event_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ree_share_event_ree_idx" ON "ree_share_event" USING btree ("ree_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "ree_share_event_visitor_idx" ON "ree_share_event" USING btree ("visitor_id","ree_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ree_share_event_conversation_key" ON "ree_share_event" USING btree ("conversation_id","ree_id") WHERE kind = 'conversation';