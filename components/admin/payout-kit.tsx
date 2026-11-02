import type { KycStatus, PayoutStatus } from '@/db/schema';
import { CREDIT_USD } from '@/lib/constants';
import type { Messages } from '@/i18n';
import { Tag } from '@/components/admin/list-kit';

/** Credits as US dollars, two decimals (1 credit = USD 0.0001). */
export const creditsUsd = (credits: number) => `$${(credits * CREDIT_USD).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const centsUsd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function KycStatusTag({ t, status }: { t: Messages; status: KycStatus | 'none' }) {
  if (status === 'none') return <Tag>{t.consoleUsers.users.kyc.none}</Tag>;
  const tone = status === 'verified' ? 'green' : status === 'rejected' ? 'red' : 'orange';
  return <Tag tone={tone}>{t.consolePayouts.kycStatus[status]}</Tag>;
}

export function PayoutStatusTag({ t, status }: { t: Messages; status: PayoutStatus }) {
  const tone = status === 'paid' ? 'green' : status === 'failed' || status === 'rejected' ? 'red' : status === 'approved' ? 'blue' : 'orange';
  return <Tag tone={tone}>{t.consolePayouts.payoutStatus[status]}</Tag>;
}
