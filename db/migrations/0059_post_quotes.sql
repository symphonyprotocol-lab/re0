ALTER TABLE "notice" DROP CONSTRAINT "notice_kind_check";--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "quote_kind" text;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "quote_post_id" uuid;--> statement-breakpoint
ALTER TABLE "post" ADD COLUMN "quote_answer_id" uuid;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_quote_post_id_post_id_fk" FOREIGN KEY ("quote_post_id") REFERENCES "public"."post"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_quote_answer_id_post_answer_id_fk" FOREIGN KEY ("quote_answer_id") REFERENCES "public"."post_answer"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_quote_idx" ON "post" USING btree ("quote_post_id") WHERE quote_post_id is not null;--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_kind_check" CHECK (kind in ('takedown', 'restore', 'credits_adjust', 'kyc', 'payout', 'role', 'verification', 'post_answered', 'post_quoted'));--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_quote_kind_check" CHECK (quote_kind is null or quote_kind in ('post', 'answer'));