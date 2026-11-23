/**
 * The live numbers public copy states -- the terms of service and the
 * pricing FAQ -- read from the console's current settings, so the pages
 * never disagree with them: the welcome gift, the site-wide payout minimum,
 * and the invitation rule (the withdrawable quota and the per-inviter
 * limit, or the "gift credits only" wording when either is 0) -- and the
 * posts' fees and limits, which are code constants (lib/domain/post.ts).
 */
import { formatCreditsUsd } from '@/lib/domain/payouts';
import { withdrawableInvitesPossible } from '@/lib/domain/invites';
import { rewardSettings } from '@/lib/services/invites';
import { sitePayoutMinimum } from '@/lib/services/payout-minimum';
import { welcomeCredits } from '@/lib/services/signup-reward';
import { QUERY_BASE_FEE } from '@/lib/constants';
import { POST_MAX_ANSWERS, POST_PAID_AGREE_MAX, POST_REPORT_THRESHOLD, POST_SUMMARY_FEE, POST_SUMMARY_FREE_REWRITES, PRIVATE_POST_MAX_REES } from '@/lib/domain/post';
import { PUBLIC_QA_REPORT_THRESHOLD } from '@/lib/domain/public-qa';
import type { Messages } from '@/i18n';
import { fill, formatNumber } from '@/i18n/format';
import type { Locale } from '@/i18n/locale';
import { effectiveCeiling } from '@/lib/services/rate-limit-settings';

export async function publicCopyValues(t: Messages, locale: Locale): Promise<Record<string, string>> {
  const [welcome, payoutMin, rewards, postDailyLimit] = await Promise.all([welcomeCredits(), sitePayoutMinimum(), rewardSettings(), effectiveCeiling('postsPerDay')]);
  const n = (value: number) => formatNumber(value, locale);
  const numbers = {
    welcomeCredits: n(welcome.credits),
    payoutMinCredits: n(payoutMin.credits),
    payoutMinUsd: formatCreditsUsd(payoutMin.credits),
    withdrawableInvites: n(rewards.withdrawableInvites),
    withdrawableInvitesPerInviter: n(rewards.withdrawableInvitesPerInviter),
    postBaseFee: n(QUERY_BASE_FEE),
    postMaxAutoCost: n(POST_MAX_ANSWERS * QUERY_BASE_FEE),
    postAgreeMax: n(POST_PAID_AGREE_MAX),
    postDailyLimit: n(postDailyLimit),
    postSummaryFee: n(POST_SUMMARY_FEE),
    postSummaryFreeRewrites: n(POST_SUMMARY_FREE_REWRITES),
    postMaxAnswers: n(POST_MAX_ANSWERS),
    privatePostMaxRees: n(PRIVATE_POST_MAX_REES),
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
