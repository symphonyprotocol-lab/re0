import { financeTime } from '@/lib/domain/admin-finance';
import { KNOWLEDGE_KIND_LIST } from '@/lib/domain/knowledge';
import { param, parseList } from '@/lib/domain/list';

export const COST_STATUSES = ['all', 'pending', 'processing', 'ready', 'failed', 'unknown'] as const;
export const COST_SORTS = ['newest', 'oldest', 'cost-high', 'cost-low'] as const;
export function knowledgeCostsView(params: URLSearchParams | Record<string, string | string[] | undefined>) {
  const kind = param(params, 'kind');
  return {
    ...parseList(params, { statuses: COST_STATUSES, sorts: COST_SORTS, sizes: [20, 50, 100] }),
    ...financeTime(params),
    kind: (KNOWLEDGE_KIND_LIST as readonly string[]).includes(kind) ? kind : 'all',
  };
}
export type KnowledgeCostsView = ReturnType<typeof knowledgeCostsView>;
/** Preserve exact supplier decimals; tiny nonzero costs must never display as $0.00. */
export function costUsd(value: string | null): string {
  if (value === null) return '—';
  return `$${value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value}`;
}
