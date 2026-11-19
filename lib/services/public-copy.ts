/**
 * The live numbers public copy states -- the terms of service and the
 * pricing FAQ -- read from the console's current settings, so the pages
 * never disagree with them: the welcome gift, the site-wide payout minimum,
 * and the invitation rule (the withdrawable quota and the per-inviter
 * limit, or the "gift credits only" wording when either is 0) -- and the
 * public posts' fees and limits, which are code constants (lib/domain/post.ts).
 */
import { formatCreditsUsd } from '@/lib/domain/payouts';
import { withdrawableInvitesPossible } from '@/lib/domain/invites';
import { rewardSettings } from '@/lib/services/invites';
import { sitePayoutMinimum } from '@/lib/services/payout-minimum';
import { welcomeCredits } from '@/lib/services/signup-reward';
import { POST_DAILY_LIMIT, POST_FEE, POST_FREE_PER_DAY, POST_MAX_ANSWERS, POST_PAID_REQUEST_REFUND_MS, POST_REPORT_THRESHOLD, POST_SUMMARY_FEE, POST_SUMMARY_FREE_REWRITES } from '@/lib/domain/post';
import { PUBLIC_QA_REPORT_THRESHOLD } from '@/lib/domain/public-qa';
import type { Messages } from '@/i18n';
import { fill, formatNumber } from '@/i18n/format';
import type { Locale } from '@/i18n/locale';

export async function publicCopyValues(t: Messages, locale: Locale): Promise<Record<string, string>> {
  const [welcome, payoutMin, rewards] = await Promise.all([welcomeCredits(), sitePayoutMinimum(), rewardSettings()]);
  const n = (value: number) => formatNumber(value, locale);
  const numbers = {
    welcomeCredits: n(welcome.credits),
    payoutMinCredits: n(payoutMin.credits),
    payoutMinUsd: formatCreditsUsd(payoutMin.credits),
    withdrawableInvites: n(rewards.withdrawableInvites),
    withdrawableInvitesPerInviter: n(rewards.withdrawableInvitesPerInviter),
    postFreePerDay: n(POST_FREE_PER_DAY),
    postFee: n(POST_FEE),
    postDailyLimit: n(POST_DAILY_LIMIT),
    postSummaryFee: n(POST_SUMMARY_FEE),
    postSummaryFreeRewrites: n(POST_SUMMARY_FREE_REWRITES),
    postMaxAnswers: n(POST_MAX_ANSWERS),
    postPaidRequestDays: n(Math.round(POST_PAID_REQUEST_REFUND_MS / 86_400_000)),
    postReportThreshold: n(POST_REPORT_THRESHOLD),
    answerReportThreshold: n(PUBLIC_QA_REPORT_THRESHOLD),
  };
  const kind = withdrawableInvitesPossible(rewards) ? 'withdrawable' : 'none';
  return {
    ...numbers,
    inviteRule: fill(t.legal.inviteRule[kind], numbers),
    inviteFaq: fill(t.site.faqInvite[kind], numbers),
  };
}
