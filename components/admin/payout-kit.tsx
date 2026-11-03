import type { KycStatus, PayoutStatus } from '@/db/schema';
import type { Messages } from '@/i18n';
import { Tag } from '@/components/admin/list-kit';
// console.css first, so these later prototype rules keep their cascade order.
import '@/components/admin/console.css';
import '@/components/admin/console-finance.css';

export { formatCentsUsd as centsUsd, formatCreditsUsd as creditsUsd } from '@/lib/domain/payouts';

/* Tag tones follow the prototype's `tag()` (suite.js): settled green, waiting orange, refused red, the rest plain. */
export function KycStatusTag({ t, status }: { t: Messages; status: KycStatus | 'none' }) {
  if (status === 'none') return <Tag>{t.consoleUsers.users.kyc.none}</Tag>;
  const tone = status === 'verified' ? 'green' : status === 'rejected' ? 'red' : status === 'pending' ? 'orange' : 'grey';
  return <Tag tone={tone}>{t.consolePayouts.kycStatus[status]}</Tag>;
}

export function PayoutStatusTag({ t, status }: { t: Messages; status: PayoutStatus }) {
  const tone = status === 'paid' ? 'green' : status === 'failed' || status === 'rejected' ? 'red' : status === 'pending' ? 'orange' : 'grey';
  return <Tag tone={tone}>{t.consolePayouts.payoutStatus[status]}</Tag>;
}
