import type { Metadata } from 'next';
import Link from 'next/link';
import { adminRee, adminReeSources, reeAudit, sourceFilter } from '@/lib/services/admin-rees';
import { answerCounts, reeStatistics, statisticsQuery } from '@/lib/services/statistics';
import { serverMessages } from '@/i18n/server';
import { PageHead } from '@/components/admin/list-kit';
import { AuditTable } from '@/components/admin/audit-kit';
import { Breadcrumbs, ReeHeader, ReeOverviewTab, ReeSourcesTab, ReeTabs, reeBackPath, reeDetailHref, reeTab, sourceParams } from '@/components/admin/ree-detail';
import { ReeStatisticsView } from '@/components/statistics/ree-statistics-view';

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function load(id: string) {
  return UUID.test(id) ? adminRee(id) : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { t } = await serverMessages();
  const detail = await load((await params).id);
  return { title: detail ? `${detail.ree.name} · ${t.consoleRees.rees.title}` : t.consoleRees.ree.notFound };
}

/** `/admin/rees/[id]` (prototype admin-ree-detail.js): four tabs as links, `from` kept for the way back. */
export default async function ReeDetailPage({ params, searchParams }: Props) {
  const { t, locale } = await serverMessages();
  const r = t.consoleRees.ree;
  const id = (await params).id;
  const query = await searchParams;
  const back = reeBackPath(query);
  const crumbs = [
    { label: t.console.nav.home, href: '/admin/overview' },
    { label: t.consoleRees.rees.title, href: back.href },
  ];
  const detail = await load(id);
  if (!detail) {
    return (
      <>
        <PageHead crumbs={crumbs} title={r.notFound} />
        <Link href={back.href} className="btn-secondary">
          {r.back}
        </Link>
      </>
    );
  }
  const tab = reeTab(query);
  const answers = await answerCounts([id], null);
  const from = back.from;
  let body;
  if (tab === 'sources') {
    const filter = sourceFilter(query);
    const data = await adminReeSources(id, filter);
    body = <ReeSourcesTab t={t} locale={locale} id={id} from={from} filter={filter} data={data} />;
  } else if (tab === 'statistics') {
    const data = await reeStatistics(id, statisticsQuery(query), { withIncome: true });
    body = (
      <ReeStatisticsView
        t={t}
        locale={locale}
        data={data}
        basePath={`/admin/rees/${id}`}
        keep={{ tab: 'statistics', ...(from ? { from } : {}) }}
        sourcesHref={reeDetailHref(id, from, 'sources', sourceParams({ q: '', status: 'ready' }))}
        showIncome
      />
    );
  } else if (tab === 'audit') {
    const rows = await reeAudit(id);
    body = (
      <section className="card overflow-hidden">
        <div className="px-5 pt-5 pb-4">
          <h2 className="text-[15px] font-bold">{r.audit.title}</h2>
          <p className="mt-1 text-[12px] text-muted">{r.audit.lede}</p>
        </div>
        <AuditTable
          t={t}
          locale={locale}
          rows={rows.map((row) => ({ id: row.audit.id, action: row.audit.action, target: row.audit.target, administrator: row.administrator, createdAt: row.audit.createdAt }))}
          from={reeDetailHref(id, from, 'audit')}
        />
      </section>
    );
  } else {
    body = <ReeOverviewTab t={t} locale={locale} detail={detail} from={from} />;
  }
  return (
    <>
      <Breadcrumbs crumbs={[...crumbs, { label: detail.ree.name }]} />
      <ReeHeader t={t} locale={locale} detail={detail} answers={answers.get(id) ?? 0} />
      <ReeTabs t={t} id={id} from={from} active={tab} />
      {body}
    </>
  );
}
