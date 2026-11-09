import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { redirect } from 'next/navigation';
import { requireAdministrator } from '@/lib/http/admin';
import { financeFilter } from '@/lib/domain/admin-finance';
import { csvHref, listHref } from '@/lib/domain/admin-lists';
import { costUsd } from '@/lib/domain/knowledge-costs';
import { CALL_PURPOSES, CALL_STATUSES, callCostBasis, modelCallsView } from '@/lib/domain/model-calls';
import { modelCallReport } from '@/lib/services/admin-model-calls';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { ConsolePeriodControls } from '@/components/admin/finance-chart';
import { ListFilters } from '@/components/admin/list-client';
import { LinkPager, OpenLink, PageHead, Person, RecordSection, RecordsTable, ResultsLine, Subline, SummaryCards, Tag } from '@/components/admin/list-kit';
import '@/components/admin/model-calls.css';

export async function generateMetadata() { return { title: (await serverMessages()).t.modelCalls.title }; }
export default async function ModelCallsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdministrator();
  const { t, locale } = await serverMessages();
  const m = t.modelCalls;
  const l = t.console.list;
  const view = modelCallsView(await searchParams);
  const report = await modelCallReport(view);
  const current = { ...view, page: report.page };
  const href = (changes: Record<string, string | number | null>) => listHref('/admin/model-calls', current, changes);
  if (report.page !== view.page) redirect(href({}));
  const n = (value: number) => formatNumber(value, locale);
  const s = report.summary;
  const models = [...new Set([...report.models.map((row) => row.model), ...(view.model ? [view.model] : [])])];
  const filtered = Boolean(view.q || view.model) || view.status !== 'all' || view.audience !== 'all' || view.purpose !== 'all' || view.period !== 'all' || view.sort !== 'newest';
  return <ConsolePage>
    <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: m.title }]} />
    <div className="model-calls-page">
      <PageHead title={m.title} lede={m.lede} actions={<div className="flex"><Link className="btn secondary sm" href="/admin/models">{m.manage}</Link><Link className="btn secondary sm" href="/admin/pricing">{m.pricing}</Link></div>} />
      <div className="model-calls-period"><ConsolePeriodControls filter={financeFilter(view)} id="model-call-period" /></div>
      <SummaryCards items={[
        { label: m.cards.calls, value: n(s.calls) }, { label: m.cards.succeeded, value: n(s.succeeded) },
        { label: m.cards.failed, value: n(s.failed + s.aborted) }, { label: m.cards.tokens, value: `${n(s.inputTokens)} / ${n(s.outputTokens)}` },
        { label: m.cards.cost, value: costUsd(s.knownCostUsd) }, { label: m.cards.estimated, value: costUsd(s.estimatedCostUsd) },
        { label: m.cards.unpriced, value: n(s.unpriced) }, { label: m.cards.latency, value: s.averageMs === null ? '—' : `${n(s.averageMs)} ms` },
      ]} />
      <p className="model-calls-note">{m.note}</p>
      <RecordSection>
        <ListFilters q={view.q} placeholder={m.search} resetHref="/admin/model-calls" filtered={filtered} defaults={{ status: 'all', audience: 'all', purpose: 'all', model: '', sort: 'newest', size: '20' }} selects={[
          { name: 'model', label: m.model, value: view.model, options: [['', m.allModels], ...models.map((value): [string, string] => [value, value])] },
          { name: 'audience', label: m.audience, value: view.audience, options: Object.entries(m.audiences) },
          { name: 'purpose', label: m.purpose, value: view.purpose, options: [['all', m.purposes.all], ...CALL_PURPOSES.map((value): [string, string] => [value, m.purposes[value]])] },
          { name: 'status', label: m.status, value: view.status, options: CALL_STATUSES.map((value): [string, string] => [value, m.statuses[value]]) },
          { name: 'sort', label: l.sort, value: view.sort, options: [['newest', l.newest], ['oldest', l.oldest], ['cost-high', m.costHigh], ['cost-low', m.costLow]] },
          { name: 'size', label: l.perPage, value: String(view.size), options: [20, 50, 100].map((value): [string, string] => [String(value), fill(l.rows, { n: value })]) },
        ]} />
        <ResultsLine t={t} total={report.total} page={report.page} size={report.size} exportHref={csvHref('/api/admin/model-calls', view)} />
        <RecordsTable label={m.records} empty={l.empty} head={[m.time, m.model, m.cost, m.user, m.audience, m.purpose, m.status, m.duration, m.input, m.output, m.details]} rows={report.items.map((row) => [
          formatDateTime(row.createdAt, locale), <><code>{row.model}</code><Subline>{row.configName ?? '—'}</Subline></>,
          <div className="model-call-price"><strong>{row.costUsd === null ? m.priceUnknown : costUsd(row.costUsd)}</strong><Subline>{row.costUsd === null ? row.status === 'unknown' ? m.historicalPriceMissing : m.priceMissing : m.basis[callCostBasis(row)]}</Subline></div>,
          row.userId ? <Person name={row.userName ?? row.userId} email={row.userEmail} href={`/admin/users/${row.userId}`} /> : '—',
          m.audiences[row.audience ?? 'unknown'], row.purpose ? m.purposes[row.purpose] : '—',
          <Tag tone={row.status === 'succeeded' ? 'green' : row.status === 'failed' ? 'red' : row.status === 'aborted' ? 'orange' : 'grey'}>{m.statuses[row.status]}</Tag>,
          row.durationMs === null ? '—' : `${n(row.durationMs)} ms`,
          row.usageKnown || row.status === 'unknown' ? n(row.inputTokens) : '—', row.usageKnown || row.status === 'unknown' ? n(row.outputTokens) : '—',
          <OpenLink href={`/admin/model-calls/${row.id}?from=${encodeURIComponent(href({}))}`}>{m.details}</OpenLink>,
        ])} />
        <LinkPager t={t} page={report.page} total={report.total} size={report.size} href={(page) => href({ page })} />
      </RecordSection>
      <section className="card model-call-groups">
        <h2>{m.groupTitle}</h2>
        <RecordsTable empty={l.empty} label={m.groupTitle} head={[m.model, m.audience, m.cards.calls, m.cards.succeeded, m.cards.failed, m.input, m.output, m.cards.cost, m.cards.estimated, m.cards.unpriced]} rows={report.models.map((row) => [
          <><code>{row.model}</code><Subline>{row.endpoint ?? '—'}</Subline></>, m.audiences[row.audience ?? 'unknown'], n(row.calls), n(row.succeeded), n(row.failed + row.aborted), n(row.inputTokens), n(row.outputTokens), costUsd(row.knownCostUsd), costUsd(row.estimatedCostUsd), n(row.unpriced),
        ])} />
      </section>
    </div>
  </ConsolePage>;
}
