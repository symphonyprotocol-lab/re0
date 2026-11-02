import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AUDIT_ACTIONS } from '@/lib/domain/audit';
import { auditView, csvHref, listHref } from '@/lib/domain/admin-lists';
import { auditCounts, listAudit } from '@/lib/services/admin-audit';
import { serverMessages } from '@/i18n/server';
import { formatNumber } from '@/i18n/format';
import { ListFilters } from '@/components/admin/list-client';
import { LinkPager, PageHead, ResultsLine, SummaryCards } from '@/components/admin/list-kit';
import { ConsoleTopbar } from '@/components/admin/console-topbar';
import { AuditTable, actionLabel } from '@/components/admin/audit-kit';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.consoleRees.audit.title };
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** `/admin/audit` (prototype admin-records.js, kind `audit`): read-only, filtered by the one list of action codes, CSV of every match. */
export default async function AuditPage({ searchParams }: Props) {
  const { t, locale } = await serverMessages();
  const a = t.consoleRees.audit;
  const l = t.console.list;
  const view = auditView(await searchParams);
  const [data, counts] = await Promise.all([listAudit(view), auditCounts()]);
  const current = { ...view, page: data.page };
  const href = (changes: Record<string, string | number | null>) => listHref('/admin/audit', current, changes);
  // A page past the end (rows went away, a stale link) lands on the last page's canonical URL.
  if (data.page !== view.page) redirect(href({}));
  const n = (value: number) => formatNumber(value, locale);
  const filtered = Boolean(view.q) || view.action !== 'all' || view.period !== 'all' || view.sort !== 'newest';
  return (
    <>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: a.title }]} />
      <PageHead title={a.title} lede={a.lede} />
      <SummaryCards
        items={[
          { label: a.cards.total, value: n(counts.total), href: listHref('/admin/audit', { size: view.size }), active: !filtered, title: l.clearFilters },
          { label: a.cards.administrators, value: n(counts.administrators) },
          { label: a.cards.actions, value: n(counts.actions) },
        ]}
      />
      <section className="card overflow-hidden">
        <ListFilters
          q={view.q}
          placeholder={a.search}
          defaults={{ action: 'all', period: 'all', sort: 'newest', size: '20' }}
          resetHref={listHref('/admin/audit', { size: view.size })}
          filtered={filtered}
          selects={[
            { name: 'action', label: a.filters.action, value: view.action, options: [['all', a.allActions], ...AUDIT_ACTIONS.map((code) => [code, actionLabel(t, code)] as [string, string])] },
            { name: 'period', label: a.filters.period, value: view.period, options: [['all', l.allTime], ['7', l.last7], ['30', l.last30], ['90', l.last90]] },
            { name: 'sort', label: a.filters.sort, value: view.sort, options: [['newest', l.newest], ['oldest', l.oldest]] },
            { name: 'size', label: l.perPage, value: String(view.size), options: [20, 50, 100].map((size) => [String(size), String(size)] as [string, string]) },
          ]}
        />
        <ResultsLine t={t} total={data.total} page={data.page} size={data.size} exportHref={csvHref('/api/admin/audit', view)} />
        <AuditTable t={t} locale={locale} rows={data.items} from={href({})} />
        <LinkPager t={t} page={data.page} total={data.total} size={data.size} href={(page) => href({ page })} />
      </section>
    </>
  );
}
