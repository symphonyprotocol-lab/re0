/**
 * What the redeem code pages share on the server: a batch's phase colours
 * and its target as two lines (docs/design/redeem-codes.md 6.1).
 */
import type { BatchSummary } from '@/lib/services/admin-redeem';
import type { Messages } from '@/i18n';
import { fill, formatNumber } from '@/i18n/format';
import { Subline } from '@/components/admin/list-kit';

export const PHASE_TONES = { active: 'green', scheduled: 'blue', expired: 'grey', disabled: 'red' } as const;

/** What a batch gives, on two lines: the target, then its credits. */
export function batchTarget(t: Messages, locale: 'zh' | 'en', batch: Pick<BatchSummary, 'kind' | 'planMonths' | 'packQuantity' | 'credits'>) {
  const r = t.redeemAdmin;
  const credits = formatNumber(batch.credits, locale);
  return (
    <>
      {batch.kind === 'plan' ? fill(r.target.plan, { months: batch.planMonths ?? 0 }) : fill(r.target.pack, { quantity: batch.packQuantity ?? 0 })}
      <Subline>{fill(batch.kind === 'plan' ? r.credits.plan : r.credits.pack, { credits })}</Subline>
    </>
  );
}
