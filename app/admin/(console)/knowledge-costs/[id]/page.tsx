import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { notFound } from 'next/navigation';
import { requireAdministrator } from '@/lib/http/admin';
import { serverMessages } from '@/i18n/server';
import { formatDateTime, formatNumber } from '@/i18n/format';
import { costUsd } from '@/lib/domain/knowledge-costs';
import { knowledgeCostDetail } from '@/lib/services/admin-knowledge-costs';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { DetailSection, Fields, PageHead, Person } from '@/components/admin/list-kit';
import { CostAmount, CostStatus, CostUsage } from '@/components/admin/knowledge-costs';
import '@/components/admin/knowledge-costs.css';

export async function generateMetadata() { return { title: (await serverMessages()).t.knowledgeCosts.receipts }; }
export default async function CostDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdministrator();
  const { t, locale } = await serverMessages();
  const c = t.knowledgeCosts;
  const r = await knowledgeCostDetail((await params).id);
  if (!r) notFound();
  const n = (value: number) => formatNumber(value, locale);
  const time = (value: Date | null) => value ? formatDateTime(value, locale) : '—';
  return <ConsolePage>
    <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: c.title, href: '/admin/knowledge-costs' }, { label: r.title }]} />
    <div className="console-body knowledge-costs-page">
      <PageHead title={r.title} lede={c.retention} actions={<Link className="btn secondary sm" href="/admin/knowledge-costs">{c.back}</Link>} />
      <DetailSection title={c.records}>
        <Fields items={[
          [c.status, <CostStatus t={t} status={r.status} />],
          [c.kind, t.common.kinds[r.kind as keyof typeof t.common.kinds] ?? r.kind],
          [c.ree, r.reeId ? <Link className="text-link" href={`/admin/rees/${r.reeId}`}>{r.reeName}</Link> : r.reeName],
          [c.user, <Person name={r.name ?? '—'} email={r.email} href={`/admin/users/${r.userId}`} />],
          [c.holdId, r.id], [c.runId, r.runId], [c.sourceId, r.knowledgeId],
          [c.createdAt, time(r.createdAt)], [c.closedAt, time(r.closedAt)],
          [c.cost, <CostAmount t={t} cost={r.costUsd} known={r.knownCostUsd} />],
          [c.reserved, n(r.reservedCredits)], [c.charged, r.chargedCredits === null ? '—' : n(r.chargedCredits)],
          [c.refunded, n(r.refundedCredits)], [c.held, n(r.heldCredits)],
          ...(r.error ? [[c.error, r.error] as [string, string]] : []),
        ]} />
        <div className="cost-notes"><p>{c.refundNote}</p>{!r.metered && <p>{c.legacy}</p>}<p>{c.unknownNote}</p></div>
        {r.knowledgeId && r.reeId && <Link className="text-link" href={`/admin/rees/${r.reeId}/sources/${r.knowledgeId}`}>{c.openSource}</Link>}
      </DetailSection>
      <DetailSection title={c.receipts}>
        {r.charges.length === 0 && <p>{c.noCalls}</p>}
        {r.charges.map((charge) => <article className="cost-receipt" key={charge.id}>
          <h3>{c.services[charge.service] ?? charge.service} · {charge.model}</h3>
          <Fields items={[
            [t.console.list.time, time(new Date(charge.at))],
            [c.endpoint, charge.endpoint], [c.account, charge.account ?? '*'],
            [c.usage, <CostUsage t={t} usage={charge.usage} />],
            [c.cost, costUsd(charge.costUsd)], [c.basis, c.bases[charge.basis]],
            [c.requestId, charge.requestId], [c.generationId, charge.generationId], [c.revision, charge.priceRevision],
            ...(charge.rate ? [
              [c.rate, `${charge.rate.usdPerUnit} USD / ${charge.rate.unit}`] as [string, string],
              [c.rateSource, charge.rate.source] as [string, string],
            ] : []),
          ]} />
          <details><summary>{c.receipts} · JSON</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 }}>{JSON.stringify(charge, null, 2)}</pre></details>
        </article>)}
      </DetailSection>
    </div>
  </ConsolePage>;
}
