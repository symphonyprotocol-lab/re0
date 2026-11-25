-- 0090_drop_competitions: takes Ree competitions (0089, shelved 2026-11-24) back out,
-- leaving the database as 0088_post_channels left it. Release PR #236 shipped 0089 to
-- production before #240 removed the feature, so it is undone here rather than deleted.
--
-- Guard first: it refuses -- and the deploy's one transaction rolls back, nothing dropped --
-- while any competition data exists: a row in one of the six tables, or a row elsewhere
-- that uses a value 0089 added (post.source, credit_hold.kind, credit_entry.reason,
-- notice.kind) or the competition model-call purposes and audit actions it introduced.
-- Then the tables go (foreign keys first) and the four widened checks get their 0088
-- definitions back. Channel tables and all other data are untouched.
DO $guard$
DECLARE
  found text[] := '{}';
  name text;
  present boolean;
BEGIN
  FOREACH name IN ARRAY ARRAY['competition', 'competition_question', 'competition_entry', 'competition_answer', 'competition_score_log', 'competition_report'] LOOP
    IF to_regclass('public.' || name) IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', name) INTO present;
      IF present THEN found := found || name; END IF;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM post WHERE source = 'competition') THEN found := found || 'post.source = competition'::text; END IF;
  IF EXISTS (SELECT 1 FROM credit_hold WHERE kind = 'competition') THEN found := found || 'credit_hold.kind = competition'::text; END IF;
  IF EXISTS (SELECT 1 FROM credit_entry WHERE reason IN ('competition_deposit_hold', 'competition_deposit_settle', 'competition_deposit_release', 'judge_hold', 'judge_settle', 'judge_refund')) THEN found := found || 'credit_entry.reason competition_deposit_* / judge_*'::text; END IF;
  IF EXISTS (SELECT 1 FROM notice WHERE kind IN ('competition_published', 'competition_balance_short', 'competition_review_ready', 'competition_results')) THEN found := found || 'notice.kind competition_*'::text; END IF;
  IF EXISTS (SELECT 1 FROM model_call WHERE purpose IN ('competition_answer', 'competition_judge')) THEN found := found || 'model_call.purpose competition_*'::text; END IF;
  IF EXISTS (SELECT 1 FROM admin_audit WHERE action LIKE 'competition.%') THEN found := found || 'admin_audit.action competition.*'::text; END IF;
  IF cardinality(found) > 0 THEN
    RAISE EXCEPTION '0090_drop_competitions refused: competition data exists (%). Nothing was dropped; decide what to do with it, then deploy again.', array_to_string(found, ', ');
  END IF;
END
$guard$;--> statement-breakpoint
DROP TABLE IF EXISTS "competition_score_log";--> statement-breakpoint
DROP TABLE IF EXISTS "competition_report";--> statement-breakpoint
DROP TABLE IF EXISTS "competition_answer";--> statement-breakpoint
DROP TABLE IF EXISTS "competition_entry";--> statement-breakpoint
DROP TABLE IF EXISTS "competition_question";--> statement-breakpoint
DROP TABLE IF EXISTS "competition";--> statement-breakpoint
ALTER TABLE "credit_entry" DROP CONSTRAINT "credit_entry_reason_check";--> statement-breakpoint
ALTER TABLE "credit_entry" ADD CONSTRAINT "credit_entry_reason_check" CHECK (reason in ('welcome', 'knowledge_hold', 'knowledge_settle', 'knowledge_refund', 'query_hold', 'query_base', 'query_refund', 'query_fee_paid', 'query_fee_earned', 'purchase', 'refund', 'chargeback', 'debt_offset', 'expire', 'payout_hold', 'payout_release', 'payout_paid', 'video_script', 'video_export', 'admin_adjust', 'video_refund', 'verify_hold', 'verify_settle', 'verify_refund', 'synthesis_hold', 'synthesis_settle', 'synthesis_refund', 'storage_charge', 'redeem', 'chargeback_reverse', 'earned_void', 'earned_restore', 'invite_reward', 'invite_reward_gift', 'task_first_ree', 'task_first_question', 'task_first_comment', 'task_first_post', 'task_first_helpful', 'check_in', 'post_hold', 'post_settle', 'post_refund', 'ai_answer_hold', 'ai_answer_settle', 'ai_answer_refund', 'earned_convert', 'earned_converted', 'deduction_hold', 'deduction_paid', 'deduction_release', 'deduction_return'));--> statement-breakpoint
ALTER TABLE "credit_hold" DROP CONSTRAINT "credit_hold_kind_check";--> statement-breakpoint
ALTER TABLE "credit_hold" ADD CONSTRAINT "credit_hold_kind_check" CHECK (kind in ('chat', 'knowledge', 'video', 'payout', 'post', 'deduction'));--> statement-breakpoint
ALTER TABLE "notice" DROP CONSTRAINT "notice_kind_check";--> statement-breakpoint
ALTER TABLE "notice" ADD CONSTRAINT "notice_kind_check" CHECK (kind in ('takedown', 'restore', 'credits_adjust', 'kyc', 'payout', 'role', 'verification', 'post_answered', 'post_quoted', 'post_paid_requests', 'post_followup', 'followup_answered', 'chats_removal', 'post_ai_answer', 'visitor_ask_paused'));--> statement-breakpoint
ALTER TABLE "post" DROP CONSTRAINT "post_source_check";--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_source_check" CHECK (source in ('post', 'anonymous', 'share', 'conversation', 'seed', 'test', 'api', 'visitor'));
