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
  return { title: t.consolePayouts.payoutDetail.reviewTitle };
}

/** `/admin/payouts/[id]`: review a pending request, or read a finished one; an approved one goes to `/payment`. */
export default async function PayoutPage({ params, searchParams }: Props) {
  const administrator = await requireAdministrator();
  return <PayoutDetailPage administrator={administrator} id={(await params).id} payment={false} query={await searchParams} />;
}
