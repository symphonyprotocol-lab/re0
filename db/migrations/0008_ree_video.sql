CREATE TABLE "ree_video" (
	"ree_id" uuid PRIMARY KEY NOT NULL,
	"generated" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"template" text DEFAULT 'editorial' NOT NULL,
	"accent_color" text DEFAULT '#127ee3' NOT NULL,
	"aspect" text DEFAULT '16:9' NOT NULL,
	"music" boolean DEFAULT true NOT NULL,
	"scenes" jsonb,
	"exports_count" integer DEFAULT 0 NOT NULL,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ree_video_template_check" CHECK (template in ('editorial', 'blueprint', 'spotlight')),
	CONSTRAINT "ree_video_aspect_check" CHECK (aspect in ('16:9', '9:16')),
	CONSTRAINT "ree_video_accent_check" CHECK (accent_color ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "ree_video_generated_check" CHECK (not generated or scenes is not null)
);
--> statement-breakpoint
CREATE TABLE "video_export" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ree_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"content_version" text NOT NULL,
	"template" text NOT NULL,
	"aspect" text NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"blob_url" text,
	"bytes" integer,
	"cost_credits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "video_export_status_check" CHECK (status in ('started', 'done', 'abandoned')),
	CONSTRAINT "video_export_template_check" CHECK (template in ('editorial', 'blueprint', 'spotlight')),
	CONSTRAINT "video_export_aspect_check" CHECK (aspect in ('16:9', '9:16')),
	CONSTRAINT "video_export_cost_check" CHECK (cost_credits >= 0)
);
--> statement-breakpoint
ALTER TABLE "credit_entry" DROP CONSTRAINT "credit_entry_reason_check";--> statement-breakpoint
ALTER TABLE "ree_video" ADD CONSTRAINT "ree_video_ree_id_ree_id_fk" FOREIGN KEY ("ree_id") REFERENCES "public"."ree"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_export" ADD CONSTRAINT "video_export_ree_id_ree_id_fk" FOREIGN KEY ("ree_id") REFERENCES "public"."ree"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_export" ADD CONSTRAINT "video_export_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "video_export_done_key" ON "video_export" USING btree ("ree_id","content_version") WHERE status = 'done';--> statement-breakpoint
CREATE INDEX "video_export_ree_idx" ON "video_export" USING btree ("ree_id","created_at");--> statement-breakpoint
CREATE INDEX "video_export_started_idx" ON "video_export" USING btree ("created_at") WHERE status = 'started';--> statement-breakpoint
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_reason_check" CHECK (reason in ('welcome', 'knowledge_hold', 'knowledge_settle', 'knowledge_refund', 'query_hold', 'query_base', 'query_refund', 'query_fee_paid', 'query_fee_earned', 'purchase', 'refund', 'chargeback', 'debt_offset', 'expire', 'payout_hold', 'payout_release', 'payout_paid', 'video_script', 'video_export', 'admin_adjust', 'video_refund'));