-- Agent-first turn, phase P3 (agent-first-proposal.md 6.5-6.11, 8.1, 8.3, 12, 13.1; 2026-10-30).
--
-- P3a: articles (an `editor` source and a draft table), comments and their
-- reports, the AI twin's answers with the creator's 作者确认, the
-- pending-questions list, immutable channel plan versions and channel
-- subscriptions, the channel-commerce settings the console owns (minimum
-- transaction price, platform fee, payout hold, payout threshold), the
-- creator's payout profile on `publisher_account`, the channel income
-- columns on `earning_event`, and in-app notifications.
-- P3b: audio (an `audio` source); its file and article images share
-- `asset_media`.
--
-- Written for the integration runner, which feeds each statement to psql in
-- autocommit mode: no BEGIN, no temp tables. The two enum values are added
-- and not used here, so the migration also runs inside one transaction.

-- ------------------------------------------------------------ source types
ALTER TYPE "source_type" ADD VALUE IF NOT EXISTS 'editor';
--> statement-breakpoint
ALTER TYPE "source_type" ADD VALUE IF NOT EXISTS 'audio';
--> statement-breakpoint

-- ----------------------------------------------------------------- channel
ALTER TABLE "channel" ADD COLUMN "subscriptions_enabled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "channel" ADD COLUMN "paid_rights_confirmed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "channel" ADD COLUMN "paid_rights_confirmed_by" uuid REFERENCES "user"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "channel_asset" ADD COLUMN "comments_closed" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- ---------------------------------------------------------- payout profile
ALTER TABLE "publisher_account" ADD COLUMN "payee_email" text;
--> statement-breakpoint
ALTER TABLE "publisher_account" ADD COLUMN "tax_form_kind" text;
--> statement-breakpoint
ALTER TABLE "publisher_account" ADD COLUMN "tax_form_status" text NOT NULL DEFAULT 'missing';
--> statement-breakpoint
ALTER TABLE "publisher_account" ADD CONSTRAINT "publisher_account_tax_form_status_ck"
  CHECK ("tax_form_status" in ('missing', 'submitted', 'verified'));
--> statement-breakpoint
ALTER TABLE "publisher_account" ADD COLUMN "tax_form_submitted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "publisher_account" ADD COLUMN "tax_form_verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "publisher_account" ADD COLUMN "tax_form_verified_by" uuid REFERENCES "administrator"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- ----------------------------------------------------------- channel income
ALTER TABLE "earning_event" ADD COLUMN "channel_id" uuid;
--> statement-breakpoint
ALTER TABLE "earning_event" ADD COLUMN "channel_subscription_id" uuid;
--> statement-breakpoint
ALTER TABLE "earning_event" ADD COLUMN "provider_transaction_id" text;
--> statement-breakpoint
ALTER TABLE "earning_event" ADD COLUMN "gross_minor" bigint;
--> statement-breakpoint
ALTER TABLE "earning_event" ADD COLUMN "share_bps" integer;
--> statement-breakpoint
CREATE INDEX "earning_event_owner_idx" ON "earning_event" ("owner_workspace_id");
--> statement-breakpoint
-- A redelivered webhook writes nothing twice: one row per (source, provider object).
CREATE UNIQUE INDEX "earning_event_reference_uq" ON "earning_event" ("source", "reference")
  WHERE "reference" IS NOT NULL;
--> statement-breakpoint

-- ------------------------------------------------------------------ drafts
CREATE TABLE "post_draft" (
  "asset_id" uuid PRIMARY KEY REFERENCES "library"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "summary" text,
  "body" text NOT NULL DEFAULT '',
  "publish_at" timestamp with time zone,
  "channel_id" uuid REFERENCES "channel"("id") ON DELETE SET NULL,
  "access" text NOT NULL DEFAULT 'free',
  "updated_by" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "post_draft_due_idx" ON "post_draft" ("publish_at") WHERE "publish_at" IS NOT NULL;
--> statement-breakpoint

-- ------------------------------------------------------------------- media
CREATE TABLE "asset_media" (
  "id" uuid PRIMARY KEY,
  "asset_id" uuid NOT NULL REFERENCES "library"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "object_key" text NOT NULL,
  "mime" text NOT NULL,
  "bytes" bigint NOT NULL,
  "sha256" text,
  "duration_ms" integer,
  "caption" text,
  "state" text NOT NULL DEFAULT 'pending',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "asset_media_kind_ck" CHECK ("kind" in ('image', 'audio')),
  CONSTRAINT "asset_media_state_ck" CHECK ("state" in ('pending', 'ready', 'replaced'))
);
--> statement-breakpoint
CREATE INDEX "asset_media_asset_idx" ON "asset_media" ("asset_id", "kind", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "asset_media_workspace_idx" ON "asset_media" ("workspace_id") WHERE "state" = 'ready';
--> statement-breakpoint

-- ---------------------------------------------------------------- comments
CREATE TABLE "comment" (
  "id" uuid PRIMARY KEY,
  "asset_id" uuid NOT NULL REFERENCES "library"("id") ON DELETE CASCADE,
  "author_user_id" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "parent_id" uuid REFERENCES "comment"("id") ON DELETE CASCADE,
  "body" text NOT NULL,
  "state" text NOT NULL DEFAULT 'visible',
  "hidden_reason" text,
  "findings" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "pinned_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "comment_state_ck" CHECK ("state" in ('visible', 'hidden', 'deleted', 'removed'))
);
--> statement-breakpoint
CREATE INDEX "comment_asset_idx" ON "comment" ("asset_id", "created_at");
--> statement-breakpoint
CREATE INDEX "comment_author_idx" ON "comment" ("author_user_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "comment_parent_idx" ON "comment" ("parent_id");
--> statement-breakpoint
CREATE TABLE "comment_report" (
  "id" uuid PRIMARY KEY,
  "comment_id" uuid NOT NULL REFERENCES "comment"("id") ON DELETE CASCADE,
  "reporter_user_id" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "reason" text NOT NULL,
  "resolution" text,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "comment_report_once_uq" ON "comment_report" ("comment_id", "reporter_user_id");
--> statement-breakpoint
CREATE INDEX "comment_report_open_idx" ON "comment_report" ("created_at") WHERE "resolved_at" IS NULL;
--> statement-breakpoint

-- --------------------------------------------------------- twin and Q&A
CREATE TABLE "twin_answer" (
  "id" uuid PRIMARY KEY,
  "channel_id" uuid NOT NULL REFERENCES "channel"("id") ON DELETE CASCADE,
  "asker_user_id" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "question" text NOT NULL,
  "outcome" text NOT NULL,
  "claims" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "versions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "twin_answer_channel_idx" ON "twin_answer" ("channel_id", "created_at" DESC);
--> statement-breakpoint
CREATE TABLE "answer_endorsement" (
  "id" uuid PRIMARY KEY,
  "channel_id" uuid NOT NULL REFERENCES "channel"("id") ON DELETE CASCADE,
  "answer_ref" uuid NOT NULL REFERENCES "twin_answer"("id") ON DELETE CASCADE,
  "version_id" uuid REFERENCES "library_version"("id") ON DELETE SET NULL,
  "version_label" text,
  "endorsed_by" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "answer_endorsement_answer_uq" ON "answer_endorsement" ("answer_ref");
--> statement-breakpoint
CREATE TABLE "channel_question" (
  "id" uuid PRIMARY KEY,
  "channel_id" uuid NOT NULL REFERENCES "channel"("id") ON DELETE CASCADE,
  "asker_user_id" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  "question" text NOT NULL,
  "source" text NOT NULL,
  "state" text NOT NULL DEFAULT 'open',
  "comment_id" uuid REFERENCES "comment"("id") ON DELETE SET NULL,
  "twin_answer_id" uuid REFERENCES "twin_answer"("id") ON DELETE SET NULL,
  "answer_asset_id" uuid REFERENCES "library"("id") ON DELETE SET NULL,
  "asker_name_consent" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "answered_at" timestamp with time zone,
  CONSTRAINT "channel_question_source_ck" CHECK ("source" in ('twin_unanswered', 'direct', 'comment')),
  CONSTRAINT "channel_question_state_ck" CHECK ("state" in ('open', 'answered', 'dismissed'))
);
--> statement-breakpoint
CREATE INDEX "channel_question_channel_idx" ON "channel_question" ("channel_id", "state", "created_at" DESC);
--> statement-breakpoint

-- ----------------------------------------------------------- subscriptions
CREATE TABLE "channel_plan_version" (
  "id" uuid PRIMARY KEY,
  "channel_id" uuid NOT NULL REFERENCES "channel"("id") ON DELETE CASCADE,
  "interval" text NOT NULL,
  "price_minor" integer NOT NULL,
  "currency" text NOT NULL DEFAULT 'USD',
  "fee_rate_bps" integer NOT NULL,
  "provider_price_id" text,
  "effective_from" timestamp with time zone NOT NULL DEFAULT now(),
  "retired_at" timestamp with time zone,
  "created_by" uuid REFERENCES "user"("id") ON DELETE SET NULL,
  CONSTRAINT "channel_plan_version_interval_ck" CHECK ("interval" in ('month', 'year')),
  CONSTRAINT "channel_plan_version_price_ck" CHECK ("price_minor" > 0),
  CONSTRAINT "channel_plan_version_fee_ck" CHECK ("fee_rate_bps" between 0 and 10000)
);
--> statement-breakpoint
CREATE INDEX "channel_plan_version_channel_idx" ON "channel_plan_version" ("channel_id", "interval", "effective_from" DESC);
--> statement-breakpoint
CREATE TABLE "channel_subscription" (
  "id" uuid PRIMARY KEY,
  "channel_id" uuid NOT NULL REFERENCES "channel"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "plan_version_id" uuid NOT NULL REFERENCES "channel_plan_version"("id"),
  "status" text NOT NULL,
  "current_period_end" timestamp with time zone NOT NULL,
  "cancel_at_period_end" boolean NOT NULL DEFAULT false,
  "provider" text NOT NULL DEFAULT 'paddle',
  "provider_subscription_id" text,
  "provider_customer_id" text,
  "observed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "channel_subscription_status_ck"
    CHECK ("status" in ('active', 'past_due', 'canceled', 'refunded', 'paused'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_subscription_provider_uq" ON "channel_subscription" ("provider", "provider_subscription_id");
--> statement-breakpoint
CREATE INDEX "channel_subscription_access_idx" ON "channel_subscription" ("workspace_id", "channel_id", "current_period_end");
--> statement-breakpoint
CREATE INDEX "channel_subscription_user_idx" ON "channel_subscription" ("user_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "channel_subscription_channel_idx" ON "channel_subscription" ("channel_id", "status");
--> statement-breakpoint

-- ------------------------------------------------------- commerce settings
-- Empty means the defaults: $5.00 minimum per transaction, 20% fee, 120-day
-- hold, $20 payout threshold (lib/domain/commerce-config.ts).
CREATE TABLE "commerce_config" (
  "id" uuid PRIMARY KEY,
  "min_price_minor" integer NOT NULL,
  "fee_rate_bps" integer NOT NULL,
  "payout_hold_days" integer NOT NULL,
  "payout_threshold_minor" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "commerce_config_time_idx" ON "commerce_config" ("created_at" DESC);
--> statement-breakpoint

-- ----------------------------------------------------------- notifications
CREATE TABLE "notification" (
  "id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "notification_user_idx" ON "notification" ("user_id", "created_at" DESC);
