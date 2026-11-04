import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { notFound } from 'next/navigation';
import { requireAdministrator } from '@/lib/http/admin';
import { costUsd } from '@/lib/domain/knowledge-costs';
import { callCostBasis } from '@/lib/domain/model-calls';
import { modelCallDetail } from '@/lib/services/admin-model-calls';
import { serverMessages } from '@/i18n/server';
import { formatDateTime, formatNumber } from '@/i18n/format';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { DetailSection, Fields, PageHead } from '@/components/admin/list-kit';

export async function generateMetadata() { return { title: (await serverMessages()).t.modelCalls.detail.title }; }
export default async function ModelCallPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdministrator();
  const { t, locale } = await serverMessages();
  const m = t.modelCalls;
  const d = m.detail;
  const row = await modelCallDetail((await params).id);
  if (!row) notFound();
  const raw = (await searchParams).from;
  const from = typeof raw === 'string' && (raw === '/admin/model-calls' || raw.startsWith('/admin/model-calls?')) && !raw.includes('\\') ? raw : '/admin/model-calls';
  const n = (value: number) => formatNumber(value, locale);
  return <ConsolePage>
    <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: m.title, href: from }, { label: d.title }]} />
    <div className="admin-record-detail">
      <PageHead title={d.title} lede={row.model} actions={<Link className="btn secondary sm" href={from}>{d.back}</Link>} />
      <DetailSection title={d.record}><Fields items={[
        [d.id, row.id], [m.time, formatDateTime(row.createdAt, locale)], [m.model, row.model], [m.config, row.configName ?? row.configId],
        [m.user, row.userId ? <Link className="text-link" href={`/admin/users/${row.userId}`}>{row.userName ?? row.userId}{row.userEmail ? ` · ${row.userEmail}` : ''}</Link> : d.unknown],
        [m.audience, m.audiences[row.audience ?? 'unknown']], [m.purpose, row.purpose ? m.purposes[row.purpose] : d.unknown],
        [m.status, m.statuses[row.status]], [m.duration, row.durationMs === null ? d.unknown : `${n(row.durationMs)} ms`],
        [d.endpoint, row.endpoint], [d.requestId, row.requestId], [d.error, row.errorCode],
      ]} /></DetailSection>
      <DetailSection title={d.usage}>
        <Fields items={[
          [m.input, row.usageKnown || row.status === 'unknown' ? n(row.inputTokens) : d.unknown], [m.output, row.usageKnown || row.status === 'unknown' ? n(row.outputTokens) : d.unknown],
          [m.cost, costUsd(row.costUsd)], [m.basisLabel, m.basis[callCostBasis(row)]],
          [d.inputPrice, row.rate ? costUsd(row.rate.usdPerUnit) : d.unknown],
          [d.outputPrice, row.rate?.outputUsdPerUnit !== undefined ? costUsd(row.rate.outputUsdPerUnit) : d.unknown],
          [d.source, row.rate?.source], [d.revision, row.priceRevision],
        ]} />
        {!row.usageKnown && <p>{d.noUsage}</p>}<p>{callCostBasis(row) === 'historical_estimate' ? d.backfillNote : d.snapshot}</p>
      </DetailSection>
    </div>
  </ConsolePage>;
}
