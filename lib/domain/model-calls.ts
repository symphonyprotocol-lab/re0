import { financeTime } from '@/lib/domain/admin-finance';
import { param, parseList } from '@/lib/domain/list';
import { rateCost, reportedGatewayCost, type ProviderRate, type ProviderUsage } from '@/lib/domain/provider-cost';

export const CALL_STATUSES = ['all', 'succeeded', 'failed', 'aborted', 'unknown'] as const;
export const CALL_PURPOSES = ['answer', 'retrieval', 'verify', 'synthesis', 'suggestions', 'video_answer', 'video_script', 'probe', 'other'] as const;
export type CallPurpose = (typeof CALL_PURPOSES)[number];
export type CallStatus = Exclude<(typeof CALL_STATUSES)[number], 'all'>;
export type CostBasis = 'provider_reported' | 'configured_rate' | 'estimated' | 'unresolved';
export function callCostBasis(call: { costBasis: CostBasis; rate: ProviderRate | null; priceRevision?: string | null }): CostBasis | 'gateway_catalog' | 'historical_estimate' {
  if (call.costBasis === 'estimated' && call.priceRevision?.startsWith('backfill:')) return 'historical_estimate';
  return call.costBasis === 'estimated' && call.rate?.source === 'https://ai-gateway.vercel.sh/v1/models' ? 'gateway_catalog' : call.costBasis;
}
export interface GenerationCallContext {
  userId?: string;
  audience?: 'free' | 'plan';
  purpose?: CallPurpose;
}
export function modelCallsView(params: URLSearchParams | Record<string, string | string[] | undefined>, now = new Date()) {
  const audience = param(params, 'audience');
  const purpose = param(params, 'purpose');
  return {
    ...parseList(params, { statuses: CALL_STATUSES, sorts: ['newest', 'oldest', 'cost-high', 'cost-low'] as const, sizes: [20, 50, 100] }),
    ...financeTime(params, now),
    audience: ['free', 'plan', 'unknown'].includes(audience) ? audience : 'all',
    purpose: (CALL_PURPOSES as readonly string[]).includes(purpose) ? purpose : 'all',
    model: param(params, 'model').trim().slice(0, 160),
  };
}
export type ModelCallsView = ReturnType<typeof modelCallsView>;

/** Missing usage or output prices cannot turn a call into a free call. */
export function generationCost(input: { gateway: boolean; metadata?: unknown; rate?: ProviderRate; usage: ProviderUsage; estimated?: boolean }): { costUsd: string | null; costBasis: CostBasis } {
  if (input.gateway) {
    try {
      const direct = reportedGatewayCost(input.metadata);
      if (direct !== null) return { costUsd: direct, costBasis: 'provider_reported' };
    } catch { return { costUsd: null, costBasis: 'unresolved' }; }
  }
  if (!input.rate || input.rate.outputUsdPerUnit === undefined) return { costUsd: null, costBasis: 'unresolved' };
  try {
    return { costUsd: rateCost(input.rate, input.usage), costBasis: input.estimated ? 'estimated' : 'configured_rate' };
  } catch { return { costUsd: null, costBasis: 'unresolved' }; }
}
