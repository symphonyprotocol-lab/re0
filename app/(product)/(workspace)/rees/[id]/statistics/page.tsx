import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { currentUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { ownedRee } from '@/lib/services/rees';
import { reeStatistics, statisticsQuery } from '@/lib/services/statistics';
import { serverMessages } from '@/i18n/server';
import { ReeTopbar } from '@/components/rees/ree-topbar';
import { OwnerReeStatistics } from '@/components/statistics/owner/ree-statistics';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.statistics.title };
}

/**
 * `/rees/[id]/statistics` (prototype dot-statistics.js): the owner's view of
 * one Ree. An official owner never sees income here (2.7: official income
 * is console-only), so the service is asked for none.
 */
export default async function ReeStatisticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = (await currentUser())!;
  const ree = await ownedRee(db(), user.id, (await params).id);
  if (!ree) notFound();
  const { t, locale } = await serverMessages();
  const showIncome = user.role !== 'official';
  const data = await reeStatistics(ree.id, statisticsQuery(await searchParams), { withIncome: showIncome });
  return (
    <>
      <ReeTopbar ree={ree} active="statistics" />
      <OwnerReeStatistics
        t={t}
        locale={locale}
        data={data}
        reeName={ree.name}
        basePath={`/rees/${ree.id}/statistics`}
        sourcesHref={`/rees/${ree.id}/knowledge?status=ready`}
        showIncome={showIncome}
      />
    </>
  );
}
