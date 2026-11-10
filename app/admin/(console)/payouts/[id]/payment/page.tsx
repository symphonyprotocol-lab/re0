import type { Metadata } from 'next';
import { requireAdministrator } from '@/lib/http/admin';
import { serverMessages } from '@/i18n/server';
import { PayoutDetailPage } from '@/components/admin/payout-detail';

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.consolePayouts.payoutDetail.paymentTitle };
}

/** `/admin/payouts/[id]/payment`: record the transfer or the failure of an approved request; read-only once done. */
export default async function PayoutPaymentPage({ params, searchParams }: Props) {
  await requireAdministrator();
  return <PayoutDetailPage id={(await params).id} payment query={await searchParams} />;
}
