import type { Messages } from '@/i18n';
import type { ProviderUsage } from '@/lib/domain/provider-cost';
import { costUsd } from '@/lib/domain/knowledge-costs';
import { Subline, Tag } from '@/components/admin/list-kit';

export function CostStatus({ t, status }: { t: Messages; status: string }) {
  return <Tag tone={status === 'ready' ? 'green' : status === 'failed' ? 'red' : status === 'unknown' ? 'grey' : 'orange'}>{t.knowledgeCosts.states[status as keyof Messages['knowledgeCosts']['states']] ?? status}</Tag>;
}
export function CostAmount({ t, cost, known }: { t: Messages; cost: string | null; known: string }) {
  return cost !== null ? <span className="mono cost-amount">{costUsd(cost)}</span> : <><span>{t.knowledgeCosts.unknown}</span><Subline>{t.knowledgeCosts.partial}: {costUsd(known)}</Subline></>;
}
export function CostUsage({ t, usage }: { t: Messages; usage: ProviderUsage }) {
  return <div className="cost-usage">{Object.keys(usage).length === 0 && '—'}{Object.entries(t.knowledgeCosts.units).map(([key, label]) => {
    const value = usage[key as keyof ProviderUsage];
    return value === undefined ? null : <span key={key}>{label}: <b className="mono">{Number(value.toFixed(6))}</b></span>;
  })}</div>;
}
