CREATE TABLE "check_in" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"credits" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_in_credits_check" CHECK (credits > 0)
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"invitee_id" uuid PRIMARY KEY NOT NULL,
	"inviter_id" uuid NOT NULL,
	"code" text NOT NULL,
	"reward_credits" integer NOT NULL,
	"withdrawable" boolean NOT NULL,
	"gift_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_self_check" CHECK (invitee_id <> inviter_id),
	CONSTRAINT "invitation_reward_check" CHECK (reward_credits >= 0 and (reward_credits > 0 or not withdrawable)),
	CONSTRAINT "invitation_gift_reason_check" CHECK (gift_reason is null or (gift_reason in ('site_quota', 'inviter_cap') and not withdrawable and reward_credits > 0))
);
--> statement-breakpoint
CREATE TABLE "invite_code" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_code_code_check" CHECK (code ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$')
);
--> statement-breakpoint
CREATE TABLE "reward_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"invites_enabled" boolean NOT NULL,
	"withdrawable_invites" integer NOT NULL,
	"withdrawable_invites_per_inviter" integer NOT NULL,
	"invite_credits" integer NOT NULL,
	"first_ree_credits" integer NOT NULL,
	"first_question_credits" integer NOT NULL,
	"first_comment_credits" integer NOT NULL,
	"check_in_credits" integer NOT NULL,
	"check_in_max_days" integer NOT NULL,
	"check_in_window_months" integer NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reward_settings_singleton_check" CHECK (id = 1),
	CONSTRAINT "reward_settings_quota_check" CHECK (withdrawable_invites between 0 and 10000000 and withdrawable_invites_per_inviter between 0 and 1000000),
	CONSTRAINT "reward_settings_credits_check" CHECK (invite_credits between 0 and 100000000 and first_ree_credits between 0 and 100000000 and first_question_credits between 0 and 100000000 and first_comment_credits between 0 and 100000000 and check_in_credits between 0 and 100000000),
	CONSTRAINT "reward_settings_check_in_check" CHECK (check_in_max_days between 0 and 3650 and check_in_window_months between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "task_reward" (
	"user_id" uuid NOT NULL,
	"task" text NOT NULL,
	"credits" integer NOT NULL,
	"ref_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_reward_user_id_task_pk" PRIMARY KEY("user_id","task"),
	CONSTRAINT "task_reward_task_check" CHECK (task in ('first_ree', 'first_question', 'first_comment')),
	CONSTRAINT "task_reward_credits_check" CHECK (credits > 0)
);
--> statement-breakpoint
ALTER TABLE "credit_entry" DROP CONSTRAINT "credit_entry_reason_check";--> statement-breakpoint
ALTER TABLE "credit_grant" ADD COLUMN "invite_funded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "task_guide_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "check_in" ADD CONSTRAINT "check_in_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invitee_id_user_id_fk" FOREIGN KEY ("invitee_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_code" ADD CONSTRAINT "invite_code_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_settings" ADD CONSTRAINT "reward_settings_updated_by_administrator_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."administrator"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_reward" ADD CONSTRAINT "task_reward_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "check_in_user_day_key" ON "check_in" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "invitation_inviter_idx" ON "invitation" USING btree ("inviter_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_code_code_key" ON "invite_code" USING btree ("code");--> statement-breakpoint
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_reason_check" CHECK (reason in ('welcome', 'knowledge_hold', 'knowledge_settle', 'knowledge_refund', 'query_hold', 'query_base', 'query_refund', 'query_fee_paid', 'query_fee_earned', 'purchase', 'refund', 'chargeback', 'debt_offset', 'expire', 'payout_hold', 'payout_release', 'payout_paid', 'video_script', 'video_export', 'admin_adjust', 'video_refund', 'verify_hold', 'verify_settle', 'verify_refund', 'synthesis_hold', 'synthesis_settle', 'synthesis_refund', 'storage_charge', 'redeem', 'chargeback_reverse', 'earned_void', 'earned_restore', 'invite_reward', 'invite_reward_gift', 'task_first_ree', 'task_first_question', 'task_first_comment', 'check_in')) NOT VALID;--> statement-breakpoint
ALTER TABLE "credit_grant" ADD CONSTRAINT "credit_grant_invite_funded_check" CHECK (not invite_funded or (source = 'earned' and withdrawable_at is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "credit_entry" VALIDATE CONSTRAINT "credit_entry_reason_check";--> statement-breakpoint
ALTER TABLE "credit_grant" VALIDATE CONSTRAINT "credit_grant_invite_funded_check";
