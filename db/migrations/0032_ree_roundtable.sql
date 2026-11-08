CREATE TABLE "synthesis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"ree_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_credits" integer DEFAULT 0 NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "synthesis_status_check" CHECK (status in ('running', 'done'))
);
--> statement-breakpoint
CREATE TABLE "synthesis_feedback" (
	"synthesis_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"vote" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "synthesis_feedback_synthesis_id_user_id_pk" PRIMARY KEY("synthesis_id","user_id"),
	CONSTRAINT "synthesis_feedback_vote_check" CHECK (vote in ('up', 'down'))
);
--> statement-breakpoint
ALTER TABLE "credit_entry" DROP CONSTRAINT "credit_entry_reason_check";--> statement-breakpoint
ALTER TABLE "synthesis" ADD CONSTRAINT "synthesis_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis" ADD CONSTRAINT "synthesis_request_id_message_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis" ADD CONSTRAINT "synthesis_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_feedback" ADD CONSTRAINT "synthesis_feedback_synthesis_id_synthesis_id_fk" FOREIGN KEY ("synthesis_id") REFERENCES "public"."synthesis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synthesis_feedback" ADD CONSTRAINT "synthesis_feedback_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "synthesis_request_key" ON "synthesis" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "synthesis_conversation_idx" ON "synthesis" USING btree ("conversation_id");--> statement-breakpoint
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_reason_check" CHECK (reason in ('welcome', 'knowledge_hold', 'knowledge_settle', 'knowledge_refund', 'query_hold', 'query_base', 'query_refund', 'query_fee_paid', 'query_fee_earned', 'purchase', 'refund', 'chargeback', 'debt_offset', 'expire', 'payout_hold', 'payout_release', 'payout_paid', 'video_script', 'video_export', 'admin_adjust', 'video_refund', 'verify_hold', 'verify_settle', 'verify_refund', 'synthesis_hold', 'synthesis_settle', 'synthesis_refund'));