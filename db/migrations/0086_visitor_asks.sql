ALTER TABLE "notice" DROP CONSTRAINT "notice_kind_check";--> statement-breakpoint
ALTER TABLE "post" DROP CONSTRAINT "post_source_check";--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "sponsor_id" uuid;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "sponsor_hold_id" uuid;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "visitor_key" text;--> statement-breakpoint
ALTER TABLE "ree" ADD COLUMN "visitor_asks" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ree" ADD COLUMN "visitor_asks_per_visitor" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "ree" ADD COLUMN "visitor_asks_per_day" integer;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_sponsor_id_user_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_visitor_idx" ON "post" USING btree ("mention_ree_id","visitor_key","created_at" DESC NULLS LAST) WHERE visitor_key is not null;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_kind_check" CHECK (kind in ('takedown', 'restore', 'credits_adjust', 'kyc', 'payout', 'role', 'verification', 'post_answered', 'post_quoted', 'post_paid_requests', 'post_followup', 'followup_answered', 'chats_removal', 'post_ai_answer', 'visitor_ask_paused'));--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_visitor_source_check" CHECK (source <> 'visitor' or (visibility = 'public' and user_id is null));--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_source_check" CHECK (source in ('post', 'anonymous', 'share', 'conversation', 'seed', 'test', 'api', 'visitor'));--> statement-breakpoint
ALTER TABLE "ree" ADD CONSTRAINT "ree_visitor_asks_check" CHECK (visitor_asks_per_visitor between 1 and 50 and (visitor_asks_per_day is null or visitor_asks_per_day between 1 and 1000));