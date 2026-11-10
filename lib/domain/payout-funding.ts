/**
 * Where a payout's money came from (review H2), as the review page and the
 * queue show it: who paid the query fees behind the earned credits it draws
 * on, what they paid them from, and the signals worth a second look. Pure:
 * the service reads the ledger, this sums it up. A decision aid only --
 * nothing here refuses a payout.
 */
import { PAYOUT_REVIEW_SIGNALS } from '@/lib/constants';

/** One asker behind a payout, as the ledger query returns it. */
export interface FundingPayerRow {
  userId: string;
  name: string;
  email: string;
  paypalEmail: string | null;
  createdAt: Date;
  disabled: boolean;
  /** Credits of the payout traced to this asker's questions. */
  credits: number;
  questions: number;
  /** Of those, questions charged the highest query fee. */
  maxFeeQuestions: number;
  firstAskedAt: Date;
  /** Owns a Ree, or asked a Ree of another owner. */
  activeElsewhere: boolean;
}

/** What the questions behind a payout were paid from, in credits (the whole query fee of each). */
export interface FundingSources {
  /** Plans and Packs bought through Paddle, and withdrawable earned credits. */
  paid: number;
  welcome: number;
  /** Redeem codes. */
  redeemed: number;
  /** Plan and Pack credits granted in the console. */
  console: number;
  /** Earned credits that were themselves paid from free credits. */
  earnedFree: number;
  /** Of `paid`: from purchases since refunded or charged back. */
  refunded: number;
}

export type FundingFlag = 'top_payer' | 'fresh_payers' | 'exclusive_payers' | 'shared_identity' | 'max_fee' | 'refunded';

export interface FundingPayer extends FundingPayerRow {
  share: number;
  /** Account at most `freshPayerDays` old at the first question. */
  fresh: boolean;
  /** Owns no Ree and asked no other owner's Rees. */
  exclusive: boolean;
  /** Shares the owner's sign-in or PayPal e-mail. */
  sharesIdentity: boolean;
}

export interface PayoutFundingSummary {
  /** Credits the payout draws on. */
  drawn: number;
  /** Of `drawn`: traced to a question; the rest is earned credits granted otherwise (the console, before the ledger named grants). */
  traced: number;
  payers: number;
  questions: number;
  topShare: number;
  top3Share: number;
  fresh: { payers: number; share: number };
  exclusive: { payers: number; share: number };
  sharedIdentity: number;
  maxFee: { questions: number; share: number };
  sources: FundingSources;
  /** Of `drawn`: earned credits whose paying purchase was since refunded or charged back. */
  drawnRefunded: number;
  flags: FundingFlag[];
  /** Largest first. */
  ranked: FundingPayer[];
}

/** An address as compared for a shared identity: lower-cased, `+tag` dropped. */
export function identityKey(email: string | null | undefined): string | null {
  const value = email?.trim().toLowerCase();
  if (!value || !value.includes('@')) return null;
  const at = value.lastIndexOf('@');
  return `${value.slice(0, at).split('+')[0]}@${value.slice(at + 1)}`;
}

const DAY_MS = 86_400_000;

export function summarizeFunding(input: {
  drawn: number;
  payers: readonly FundingPayerRow[];
  sources: FundingSources;
  drawnRefunded: number;
  /** The owner's sign-in e-mail, their PayPal e-mail and the one this payout goes to. */
  ownerEmails: readonly (string | null)[];
}): PayoutFundingSummary {
  const signals = PAYOUT_REVIEW_SIGNALS;
  const owner = new Set(input.ownerEmails.map(identityKey).filter((key): key is string => key !== null));
  const traced = input.payers.reduce((sum, payer) => sum + payer.credits, 0);
  const share = (credits: number) => (input.drawn > 0 ? credits / input.drawn : 0);
  const ranked = [...input.payers]
    .sort((a, b) => b.credits - a.credits || a.userId.localeCompare(b.userId))
    .map((payer): FundingPayer => ({
      ...payer,
      share: share(payer.credits),
      fresh: payer.firstAskedAt.getTime() - payer.createdAt.getTime() <= signals.freshPayerDays * DAY_MS,
      exclusive: !payer.activeElsewhere,
      sharesIdentity: [payer.email, payer.paypalEmail].some((email) => {
        const key = identityKey(email);
        return key !== null && owner.has(key);
      }),
    }));
  const total = (rows: FundingPayer[]) => rows.reduce((sum, payer) => sum + payer.credits, 0);
  const fresh = ranked.filter((payer) => payer.fresh);
  const exclusive = ranked.filter((payer) => payer.exclusive);
  const questions = ranked.reduce((sum, payer) => sum + payer.questions, 0);
  const maxFeeQuestions = ranked.reduce((sum, payer) => sum + payer.maxFeeQuestions, 0);
  const summary = {
    drawn: input.drawn,
    traced,
    payers: ranked.length,
    questions,
    topShare: share(total(ranked.slice(0, 1))),
    top3Share: share(total(ranked.slice(0, 3))),
    fresh: { payers: fresh.length, share: share(total(fresh)) },
    exclusive: { payers: exclusive.length, share: share(total(exclusive)) },
    sharedIdentity: ranked.filter((payer) => payer.sharesIdentity).length,
    maxFee: { questions: maxFeeQuestions, share: questions > 0 ? maxFeeQuestions / questions : 0 },
    sources: input.sources,
    drawnRefunded: input.drawnRefunded,
    ranked,
  };
  const flags: FundingFlag[] = [];
  if (summary.payers > 0 && summary.topShare >= signals.topPayerShare) flags.push('top_payer');
  if (fresh.length > 0 && summary.fresh.share >= signals.freshPayerShare) flags.push('fresh_payers');
  if (exclusive.length > 0 && summary.exclusive.share >= signals.exclusivePayerShare) flags.push('exclusive_payers');
  if (summary.sharedIdentity >= signals.sharedIdentityPayers) flags.push('shared_identity');
  if (maxFeeQuestions > 0 && summary.maxFee.share >= signals.maxFeeShare) flags.push('max_fee');
  if (input.drawnRefunded > 0 && share(input.drawnRefunded) >= signals.refundedShare) flags.push('refunded');
  return { ...summary, flags };
}
