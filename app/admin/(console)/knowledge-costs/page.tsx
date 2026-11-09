import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { redirect } from 'next/navigation';
import { requireAdministrator } from '@/lib/http/admin';
import { serverMessages } from '@/i18n/server';
import { formatDateTime, formatNumber } from '@/i18n/format';
import { COST_SORTS, COST_STATUSES, costUsd, knowledgeCostsView } from '@/lib/domain/knowledge-costs';
import { KNOWLEDGE_KIND_LIST } from '@/lib/domain/knowledge';
import { financeFilter } from '@/lib/domain/admin-finance';
import { csvHref, listHref } from '@/lib/domain/admin-lists';
import { knowledgeCostReport } from '@/lib/services/admin-knowledge-costs';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { ConsolePeriodControls } from '@/components/admin/finance-chart';
import { ListFilters } from '@/components/admin/list-client';
import { Clip, LinkPager, OpenLink, PageHead, Person, RecordSection, RecordsTable, ResultsLine, Subline, SummaryCards } from '@/components/admin/list-kit';
import { CostAmount, CostStatus, CostUsage } from '@/components/admin/knowledge-costs';
import '@/components/admin/knowledge-costs.css';

export async function generateMetadata() { return { title: (await serverMessages()).t.knowledgeCosts.title }; }
export default async function KnowledgeCostsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdministrator();
  const { t, locale } = await serverMessages();
  const c = t.knowledgeCosts;
  const l = t.console.list;
  const view = knowledgeCostsView(await searchParams);
  const report = await knowledgeCostReport(view);
  const current = { ...view, page: report.page };
  const href = (changes: Record<string, string | number | null>) => listHref('/admin/knowledge-costs', current, changes);
  if (report.page !== view.page) redirect(href({}));
  const n = (value: number) => formatNumber(value, locale);
  const time = (value: Date | null) => value ? formatDateTime(value, locale) : '—';
  const s = report.summary;
  const overviewCost = (value: string) => <span title={costUsd(value)}>{Number(value) > 0 && Number(value) < 0.00000001 ? '< $0.00000001' : `$${Number(value).toLocaleString('en-US', { maximumFractionDigits: 8 })}`}</span>;
  return <ConsolePage>
    <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: c.title }]} />
    <div className="console-body knowledge-costs-page">
      <PageHead title={c.title} lede={c.description} actions={<div className="flex"><Link className="btn secondary sm" href="/admin/models">{t.console.nav.models} · {t.servicePricing.title}</Link><Link className="btn secondary sm" href="/admin/firecrawl">Firecrawl · {t.servicePricing.title}</Link></div>} />
      <div className="cost-period"><ConsolePeriodControls filter={financeFilter(view)} id="knowledge-cost-period" /></div>
      <div className="card cost-filters"><ListFilters q={view.q} placeholder={c.search} resetHref="/admin/knowledge-costs" filtered={Boolean(view.q) || view.kind !== 'all' || view.status !== 'all' || view.period !== 'all' || view.sort !== 'newest'} defaults={{ page: '1', size: '20', status: 'all', kind: 'all', sort: 'newest' }} selects={[
          { name: 'status', label: c.status, value: view.status, options: COST_STATUSES.map((v) => [v, v === 'all' ? l.all : c.states[v]]) },
          { name: 'kind', label: c.kind, value: view.kind, options: [['all', l.all], ...KNOWLEDGE_KIND_LIST.map((v): [string, string] => [v, t.common.kinds[v]])] },
          { name: 'sort', label: l.sort, value: view.sort, options: COST_SORTS.map((v) => [v, v === 'newest' ? l.newest : v === 'oldest' ? l.oldest : v === 'cost-high' ? c.costHigh : c.costLow]) },
          { name: 'size', label: l.perPage, value: String(view.size), options: [20, 50, 100].map((v) => [String(v), String(v)]) },
        ]} /></div>
      <SummaryCards items={[
        { label: c.summary.cost, value: overviewCost(s.knownCostUsd) },
        { label: c.summary.failedCost, value: overviewCost(s.failedCostUsd) },
        { label: c.summary.charged, value: n(s.chargedCredits) },
        { label: c.summary.refunded, value: n(s.refundedCredits) },
        { label: c.summary.held, value: n(s.heldCredits) },
        { label: c.summary.attempts, value: n(s.attempts) },
        { label: c.summary.ready, value: n(s.ready) },
        { label: c.summary.failed, value: n(s.failed) },
        { label: c.summary.active, value: n(s.active) },
        { label: c.summary.unknown, value: n(s.unknown) },
      ]} />
      <div className="cost-notes"><p>{c.note}</p><p>{c.unknownNote}</p><p>{c.refundNote}</p></div>
      <RecordSection>
        <h2 className="cost-section-title">{c.providers}</h2>
        <RecordsTable head={[c.service, c.basis, c.calls, c.usage, c.cost]} empty={l.empty} rows={report.providers.map((p) => [
          <><strong>{c.services[p.service as keyof typeof c.services] ?? p.service}</strong><Subline>{p.model}</Subline><Subline>{p.endpoint}</Subline></>,
          c.bases[p.basis as keyof typeof c.bases] ?? p.basis,
          n(p.calls),
          <CostUsage t={t} usage={Object.fromEntries(['inputTokens', 'outputTokens', 'audioInputTokens', 'seconds', 'firecrawlCredits'].filter((key) => Number(p[key as keyof typeof p]) > 0).map((key) => [key, Number(p[key as keyof typeof p])]))} />,
          <><span className="mono cost-amount">{costUsd(p.costUsd)}</span>{p.unresolved > 0 && <Subline>{c.unknown}: {n(p.unresolved)}</Subline>}</>,
        ])} />
      </RecordSection>
      <RecordSection>
        <h2 className="cost-section-title">{c.records}</h2>
        <ResultsLine t={t} total={report.total} page={report.page} size={report.size} exportHref={csvHref('/api/admin/knowledge-costs', current)} />
        <RecordsTable head={[c.source, c.user, c.time, c.status, c.cost, c.charged, c.refunded, c.held, l.details]} empty={l.empty} rows={report.items.map((r) => [
          <><Clip value={r.title} /><Subline>{r.reeName} · {t.common.kinds[r.kind as keyof typeof t.common.kinds] ?? r.kind}</Subline></>,
          <Person name={r.name ?? '—'} email={r.email} href={`/admin/users/${r.userId}`} />,
          <>{time(r.createdAt)}<Subline>{time(r.closedAt)}</Subline></>,
          <CostStatus t={t} status={r.status} />,
          <CostAmount t={t} cost={r.costUsd} known={r.knownCostUsd} />,
          r.chargedCredits === null ? '—' : n(r.chargedCredits), n(r.refundedCredits), n(r.heldCredits),
          <OpenLink href={`/admin/knowledge-costs/${r.id}`}>{c.details}</OpenLink>,
        ])} />
        <LinkPager t={t} page={report.page} total={report.total} size={report.size} href={(page) => href({ page })} />
      </RecordSection>
    </div>
  </ConsolePage>;
}
