import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { csvHref, listHref, redeemBatchesView } from '@/lib/domain/admin-lists';
import { batchCounts, listBatches } from '@/lib/services/admin-redeem';
import { currentUnitCredits } from '@/lib/services/pricing';
import { db } from '@/lib/infra/db';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { ListFilters } from '@/components/admin/list-client';
import { Clip, LinkPager, OpenLink, PageHead, RecordSection, RecordsTable, ResultsLine, Subline, SummaryCards, Tag } from '@/components/admin/list-kit';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { RecordPage } from '@/components/admin/finance-chart';
import { CreateBatchButton } from '@/components/admin/redeem-codes';
import { batchTarget, PHASE_TONES } from '@/components/admin/redeem-kit';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.redeemAdmin.title };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** `/admin/redeem-codes` (docs/design/redeem-codes.md 6.1): every batch, filtered, with the new-batch form. */
export default async function RedeemCodesPage({ searchParams }: Props) {
  const { t, locale } = await serverMessages();
  const r = t.redeemAdmin;
  const l = t.console.list;
  const view = redeemBatchesView(await searchParams);
  const [data, counts, planCredits, packCredits] = await Promise.all([
    listBatches(view),
    batchCounts(),
    currentUnitCredits(db(), 'plan'),
    currentUnitCredits(db(), 'pack'),
  ]);
  const current = { ...view, page: data.page };
  const href = (changes: Record<string, string | number | null>) => listHref('/admin/redeem-codes', current, changes);
  if (data.page !== view.page) redirect(href({}));
  const n = (value: number) => formatNumber(value, locale);
  const time = (value: Date | null) => (value ? formatDateTime(value, locale) : '—');
  const filtered = Boolean(view.q) || view.status !== 'all' || view.kind !== 'all' || view.period !== 'all' || view.sort !== 'newest';
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: r.title }]} />
      <RecordPage kind="redeem-codes">
        <PageHead title={r.title} lede={r.lede} actions={<CreateBatchButton planCredits={planCredits} packCredits={packCredits} />} />
        <SummaryCards
          items={[
            { label: r.cards.batches, value: n(counts.batches) },
            { label: r.cards.active, value: n(counts.active) },
            { label: r.cards.codes, value: n(counts.codes) },
            { label: r.cards.redemptions, value: n(counts.redemptions) },
          ]}
        />
        <RecordSection>
          <ListFilters
            q={view.q}
            placeholder={r.search}
            defaults={{ status: 'all', kind: 'all', period: 'all', sort: 'newest', size: '20' }}
            resetHref={listHref('/admin/redeem-codes', { size: view.size })}
            filtered={filtered}
            selects={[
              { name: 'status', label: r.filters.status, value: view.status, options: [['all', l.allStatuses], ...(['active', 'scheduled', 'expired', 'disabled'] as const).map((phase) => [phase, r.phases[phase]] as [string, string])] },
              { name: 'kind', label: r.filters.kind, value: view.kind, options: [['all', r.allKinds], ['plan', r.kinds.plan], ['pack', r.kinds.pack]] },
              { name: 'period', label: r.filters.period, value: view.period, options: [['all', l.allTime], ['7', l.last7], ['30', l.last30], ['90', l.last90]] },
              { name: 'sort', label: r.filters.sort, value: view.sort, options: [['newest', l.newest], ['oldest', l.oldest]] },
              { name: 'size', label: l.perPage, value: String(view.size), options: [20, 50, 100].map((size) => [String(size), fill(l.rows, { n: size })] as [string, string]) },
            ]}
          />
          <ResultsLine t={t} total={data.total} page={data.page} size={data.size} exportHref={csvHref('/api/admin/redeem-batches', view)} />
          <RecordsTable
            label={l.tableRegion}
            empty={l.empty}
            head={[r.columns.name, r.columns.target, r.columns.codes, r.columns.used, r.columns.window, r.columns.status, r.columns.created, r.columns.actions]}
            rows={data.items.map((batch) => [
              <Clip key="name" value={batch.name} />,
              batchTarget(t, locale, batch),
              <span key="codes" className="mono">{n(batch.codeCount)}</span>,
              <span key="used" className="mono">
                {batch.capacity === null ? n(batch.redemptionCount) : fill(r.usedOf, { used: n(batch.redemptionCount), total: n(batch.capacity) })}
              </span>,
              <span key="window">
                {fill(r.from, { date: time(batch.startsAt) })}
                <Subline>{batch.expiresAt ? fill(r.until, { date: time(batch.expiresAt) }) : r.noExpiry}</Subline>
              </span>,
              <Tag key="status" tone={PHASE_TONES[batch.phase]}>{r.phases[batch.phase]}</Tag>,
              <span key="created">
                {time(batch.createdAt)}
                <Subline>{batch.createdByName ?? '—'}</Subline>
              </span>,
              <OpenLink key="open" href={`/admin/redeem-codes/${batch.id}`}>{r.open}</OpenLink>,
            ])}
          />
          <LinkPager t={t} page={data.page} total={data.total} size={data.size} href={(page) => href({ page })} />
        </RecordSection>
      </RecordPage>
    </ConsolePage>
  );
}
