import type { KycStatus, PayoutStatus } from '@/db/schema';
import type { Messages } from '@/i18n';
import { Tag } from '@/components/admin/list-kit';

export { formatCentsUsd as centsUsd, formatCreditsUsd as creditsUsd } from '@/lib/domain/payouts';

export function KycStatusTag({ t, status }: { t: Messages; status: KycStatus | 'none' }) {
  if (status === 'none') return <Tag>{t.consoleUsers.users.kyc.none}</Tag>;
  const tone = status === 'verified' ? 'green' : status === 'rejected' ? 'red' : 'orange';
  return <Tag tone={tone}>{t.consolePayouts.kycStatus[status]}</Tag>;
}

export function PayoutStatusTag({ t, status }: { t: Messages; status: PayoutStatus }) {
  const tone = status === 'paid' ? 'green' : status === 'failed' || status === 'rejected' ? 'red' : status === 'approved' ? 'blue' : 'orange';
  return <Tag tone={tone}>{t.consolePayouts.payoutStatus[status]}</Tag>;
}
