CREATE TABLE "redeem_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"note" text,
	"kind" text NOT NULL,
	"plan_months" integer,
	"pack_quantity" integer,
	"credits" bigint NOT NULL,
	"code_prefix" text,
	"code_count" integer NOT NULL,
	"max_redemptions" integer,
	"per_user_limit" integer DEFAULT 1 NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"redemption_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "redeem_batch_kind_check" CHECK (kind in ('plan', 'pack')),
	CONSTRAINT "redeem_batch_status_check" CHECK (status in ('active', 'disabled')),
	CONSTRAINT "redeem_batch_target_check" CHECK ((kind = 'plan') = (plan_months is not null) and (kind = 'pack') = (pack_quantity is not null)),
	CONSTRAINT "redeem_batch_months_check" CHECK (plan_months is null or plan_months between 1 and 12),
	CONSTRAINT "redeem_batch_quantity_check" CHECK (pack_quantity is null or pack_quantity between 1 and 10),
	CONSTRAINT "redeem_batch_credits_check" CHECK (credits between 1 and 100000000),
	CONSTRAINT "redeem_batch_count_check" CHECK (code_count between 1 and 10000),
	CONSTRAINT "redeem_batch_limits_check" CHECK ((max_redemptions is null or max_redemptions >= 1) and (max_redemptions is not null or code_count = 1) and per_user_limit >= 1),
	CONSTRAINT "redeem_batch_window_check" CHECK (expires_at is null or starts_at < expires_at),
	CONSTRAINT "redeem_batch_name_check" CHECK (char_length(name) between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "redeem_code" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"code_digest" text NOT NULL,
	"code_sealed" text NOT NULL,
	"code_last4" text NOT NULL,
	"max_redemptions" integer,
	"redemption_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_redeemed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "redeem_code_status_check" CHECK (status in ('active', 'disabled')),
	CONSTRAINT "redeem_code_count_check" CHECK (redemption_count >= 0 and (max_redemptions is null or redemption_count <= max_redemptions))
);
--> statement-breakpoint
CREATE TABLE "redeem_redemption" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"credits" bigint NOT NULL,
	"plan_months" integer,
	"plan_starts_at" timestamp with time zone,
	"plan_ends_at" timestamp with time zone,
	"request_id" uuid,
	"ip_hash" text,
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "redeem_redemption_kind_check" CHECK (kind in ('plan', 'pack')),
	CONSTRAINT "redeem_redemption_plan_check" CHECK ((kind = 'plan') = (plan_months is not null and plan_starts_at is not null and plan_ends_at is not null))
);
--> statement-breakpoint
ALTER TABLE "credit_entry" DROP CONSTRAINT "credit_entry_reason_check";--> statement-breakpoint
ALTER TABLE "credit_grant" ADD COLUMN "redemption_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_grant" ADD COLUMN "redemption_period" integer;--> statement-breakpoint
ALTER TABLE "redeem_batch" ADD CONSTRAINT "redeem_batch_created_by_administrator_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."administrator"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redeem_code" ADD CONSTRAINT "redeem_code_batch_id_redeem_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."redeem_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redeem_redemption" ADD CONSTRAINT "redeem_redemption_code_id_redeem_code_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."redeem_code"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redeem_redemption" ADD CONSTRAINT "redeem_redemption_batch_id_redeem_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."redeem_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redeem_redemption" ADD CONSTRAINT "redeem_redemption_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redeem_redemption" ADD CONSTRAINT "redeem_redemption_revoked_by_administrator_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."administrator"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "redeem_batch_created_idx" ON "redeem_batch" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "redeem_batch_status_idx" ON "redeem_batch" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "redeem_code_digest_key" ON "redeem_code" USING btree ("code_digest");--> statement-breakpoint
CREATE INDEX "redeem_code_batch_idx" ON "redeem_code" USING btree ("batch_id","created_at");--> statement-breakpoint
CREATE INDEX "redeem_code_last4_idx" ON "redeem_code" USING btree ("batch_id","code_last4");--> statement-breakpoint
CREATE UNIQUE INDEX "redeem_redemption_request_key" ON "redeem_redemption" USING btree ("user_id","request_id") WHERE request_id is not null;--> statement-breakpoint
CREATE INDEX "redeem_redemption_batch_user_idx" ON "redeem_redemption" USING btree ("batch_id","user_id");--> statement-breakpoint
CREATE INDEX "redeem_redemption_code_idx" ON "redeem_redemption" USING btree ("code_id","created_at");--> statement-breakpoint
CREATE INDEX "redeem_redemption_batch_time_idx" ON "redeem_redemption" USING btree ("batch_id","created_at");--> statement-breakpoint
CREATE INDEX "redeem_redemption_plan_idx" ON "redeem_redemption" USING btree ("user_id","plan_ends_at") WHERE kind = 'plan' and revoked_at is null;--> statement-breakpoint
CREATE INDEX "redeem_redemption_plan_due_idx" ON "redeem_redemption" USING btree ("plan_ends_at") WHERE kind = 'plan' and revoked_at is null;--> statement-breakpoint
ALTER TABLE "credit_grant" ADD CONSTRAINT "credit_grant_redemption_id_redeem_redemption_id_fk" FOREIGN KEY ("redemption_id") REFERENCES "public"."redeem_redemption"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grant_redemption_key" ON "credit_grant" USING btree ("redemption_id","redemption_period") WHERE redemption_id is not null;--> statement-breakpoint
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_reason_check" CHECK (reason in ('welcome', 'knowledge_hold', 'knowledge_settle', 'knowledge_refund', 'query_hold', 'query_base', 'query_refund', 'query_fee_paid', 'query_fee_earned', 'purchase', 'refund', 'chargeback', 'debt_offset', 'expire', 'payout_hold', 'payout_release', 'payout_paid', 'video_script', 'video_export', 'admin_adjust', 'video_refund', 'verify_hold', 'verify_settle', 'verify_refund', 'synthesis_hold', 'synthesis_settle', 'synthesis_refund', 'storage_charge', 'redeem'));--> statement-breakpoint
ALTER TABLE "credit_grant" ADD CONSTRAINT "credit_grant_origin_check" CHECK (purchase_id is null or redemption_id is null);--> statement-breakpoint
ALTER TABLE "credit_grant" ADD CONSTRAINT "credit_grant_redemption_check" CHECK ((redemption_id is null) = (redemption_period is null));