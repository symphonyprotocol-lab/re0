/**
 * The live numbers public copy states -- the terms of service and the
 * pricing FAQ -- read from the console's current settings, so the pages
 * never disagree with them: the welcome gift, the site-wide payout minimum,
 * and the invitation rule (the withdrawable quota and the per-inviter
 * limit, or the "gift credits only" wording when either is 0).
 */
import { formatCreditsUsd } from '@/lib/domain/payouts';
import { withdrawableInvitesPossible } from '@/lib/domain/invites';
import { rewardSettings } from '@/lib/services/invites';
import { sitePayoutMinimum } from '@/lib/services/payout-minimum';
import { welcomeCredits } from '@/lib/services/signup-reward';
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
  };
  const kind = withdrawableInvitesPossible(rewards) ? 'withdrawable' : 'none';
  return {
    ...numbers,
    inviteRule: fill(t.legal.inviteRule[kind], numbers),
    inviteFaq: fill(t.site.faqInvite[kind], numbers),
  };
}
