CREATE TABLE "billing_event" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"outcome" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_debt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"remaining" bigint NOT NULL,
	"purchase_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	CONSTRAINT "credit_debt_remaining_check" CHECK (remaining >= 0 and remaining <= amount and amount > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"paddle_transaction_id" text NOT NULL,
	"paddle_subscription_id" text,
	"status" text DEFAULT 'paid' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"credits" bigint NOT NULL,
	"reversed_credits" bigint DEFAULT 0 NOT NULL,
	"adjustment_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_kind_check" CHECK (kind in ('plan', 'pack')),
	CONSTRAINT "purchase_status_check" CHECK (status in ('paid', 'refunded', 'chargeback')),
	CONSTRAINT "purchase_quantity_check" CHECK (quantity between 1 and 10),
	CONSTRAINT "purchase_reversed_check" CHECK (reversed_credits between 0 and credits)
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"paddle_subscription_id" text NOT NULL,
	"paddle_customer_id" text,
	"status" text NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"paddle_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_status_check" CHECK (status in ('active', 'cancelled', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "credit_entry" DROP CONSTRAINT "credit_entry_reason_check";--> statement-breakpoint
ALTER TABLE "credit_grant" ADD COLUMN "period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_grant" ADD COLUMN "purchase_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_debt" ADD CONSTRAINT "credit_debt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_debt" ADD CONSTRAINT "credit_debt_purchase_id_purchase_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchase"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_event_time_idx" ON "billing_event" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "credit_debt_open_idx" ON "credit_debt" USING btree ("user_id") WHERE remaining > 0;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_paddle_transaction_key" ON "purchase" USING btree ("paddle_transaction_id");--> statement-breakpoint
CREATE INDEX "purchase_user_idx" ON "purchase" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_paddle_key" ON "subscription" USING btree ("paddle_subscription_id");--> statement-breakpoint
CREATE INDEX "subscription_user_idx" ON "subscription" USING btree ("user_id","status");--> statement-breakpoint
ALTER TABLE "credit_grant" ADD CONSTRAINT "credit_grant_purchase_id_purchase_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchase"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grant_purchase_key" ON "credit_grant" USING btree ("purchase_id") WHERE purchase_id is not null;--> statement-breakpoint
CREATE INDEX "credit_grant_expiry_idx" ON "credit_grant" USING btree ("expires_at") WHERE source = 'plan' and remaining > 0;--> statement-breakpoint
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_reason_check" CHECK (reason in ('welcome', 'knowledge_hold', 'knowledge_settle', 'knowledge_refund', 'query_hold', 'query_base', 'query_refund', 'query_fee_paid', 'query_fee_earned', 'purchase', 'refund', 'chargeback', 'debt_offset', 'expire', 'payout_hold', 'payout_release', 'payout_paid', 'video_script', 'video_export', 'admin_adjust'));--> statement-breakpoint
ALTER TABLE "credit_grant" ADD CONSTRAINT "credit_grant_plan_check" CHECK ((source = 'plan') = (expires_at is not null));