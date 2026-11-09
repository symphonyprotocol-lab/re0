/** Read-only reports over durable reservation/receipt snapshots. Supplier costs
 * and customer credits are deliberately separate: failed work still costs us. */
import { sql, type SQL } from 'drizzle-orm';
import { financeRange } from '@/lib/domain/admin-finance';
import { clampPage, isUuid, likePattern } from '@/lib/domain/list';
import type { KnowledgeCostsView } from '@/lib/domain/knowledge-costs';
import type { ProviderCharge } from '@/lib/domain/provider-cost';
import { db } from '@/lib/infra/db';

export interface CostRunRow {
  id: string; knowledgeId: string | null; reeId: string | null; userId: string;
  title: string; reeName: string; kind: string; name: string | null; email: string | null;
  runId: string | null; status: string; error: string | null; metered: boolean;
  charges: ProviderCharge[]; createdAt: Date; closedAt: Date | null;
  reservedCredits: number; chargedCredits: number | null; refundedCredits: number; heldCredits: number;
  costUsd: string | null; knownCostUsd: string; calls: number; unresolved: number;
}
export interface CostSummary {
  attempts: number; ready: number; failed: number; active: number; unknown: number;
  knownCostUsd: string; failedCostUsd: string; chargedCredits: number; refundedCredits: number; heldCredits: number;
}
export interface CostProviderRow {
  service: string; endpoint: string; model: string; basis: string; calls: number;
  costUsd: string; unresolved: number; inputTokens: string; outputTokens: string; audioInputTokens: string; seconds: string; firecrawlCredits: string;
}
const base = sql`with runs as (
  select r.*, u.name, u.email, h.closed_at, h.amount as reserved_credits,
    case when h.status = 'held' then h.amount else 0 end as held_credits,
    case when h.status = 'released' then h.amount when h.status = 'settled' then greatest(h.amount - coalesce(r.charged_credits, 0), 0) else 0 end as refunded_credits,
    coalesce(c.cost, 0)::text as known_cost_usd,
    case when not r.metered or c.unresolved > 0 then null else coalesce(c.cost, 0)::text end as cost_usd,
    c.calls, c.unresolved
  from knowledge_cost_run r join credit_hold h on h.id = r.id
  left join "user" u on u.id = r.user_id
  cross join lateral (
    select count(*)::int as calls, count(*) filter(where a->>'costUsd' is null)::int as unresolved,
      sum((a->>'costUsd')::numeric) as cost from jsonb_array_elements(r.charges) a
  ) c
)`;
function conditions(view: KnowledgeCostsView): SQL {
  const clauses: SQL[] = [];
  if (view.status !== 'all') clauses.push(sql`status = ${view.status}`);
  if (view.kind !== 'all') clauses.push(sql`kind = ${view.kind}`);
  if (view.q) {
    const q = likePattern(view.q);
    clauses.push(sql`(title ilike ${q} or ree_name ilike ${q} or name ilike ${q} or email ilike ${q} or knowledge_id::text ilike ${q} or run_id ilike ${q} or id::text ilike ${q})`);
  }
  const range = financeRange(view);
  if (range) clauses.push(sql`created_at >= ${new Date(range.start).toISOString()}::timestamptz and created_at < ${new Date(range.end).toISOString()}::timestamptz`);
  return clauses.length ? sql`where ${sql.join(clauses, sql` and `)}` : sql``;
}
function row(r: Record<string, unknown>): CostRunRow {
  return {
    id: String(r.id), knowledgeId: r.knowledge_id as string | null, reeId: r.ree_id as string | null, userId: String(r.user_id),
    title: String(r.title), reeName: String(r.ree_name), kind: String(r.kind), name: r.name as string | null, email: r.email as string | null,
    runId: r.run_id as string | null, status: String(r.status), error: r.error as string | null, metered: Boolean(r.metered), charges: r.charges as ProviderCharge[],
    createdAt: new Date(String(r.created_at)), closedAt: r.closed_at ? new Date(String(r.closed_at)) : null,
    reservedCredits: Number(r.reserved_credits), chargedCredits: r.charged_credits === null ? null : Number(r.charged_credits),
    refundedCredits: Number(r.refunded_credits), heldCredits: Number(r.held_credits), costUsd: r.cost_usd as string | null,
    knownCostUsd: String(r.known_cost_usd), calls: Number(r.calls), unresolved: Number(r.unresolved),
  };
}
export async function knowledgeCostReport(view: KnowledgeCostsView, options: { all?: boolean } = {}) {
  const database = db();
  const where = conditions(view);
  // One statement gives cards, provider aggregates and the page one consistent DB snapshot.
  const order = { newest: sql`created_at desc`, oldest: sql`created_at asc`, 'cost-high': sql`cost_usd::numeric desc nulls last, created_at desc`, 'cost-low': sql`cost_usd::numeric asc nulls last, created_at desc` }[view.sort];
  const result = await database.execute(sql`${base}, filtered as (select * from runs ${where}), totals as (
    select count(*)::int as attempts, count(*) filter(where status = 'ready')::int as ready,
      count(*) filter(where status = 'failed')::int as failed,
      count(*) filter(where status in ('pending', 'processing'))::int as active,
      count(*) filter(where cost_usd is null)::int as unknown,
      coalesce(sum(known_cost_usd::numeric), 0)::text as cost,
      coalesce(sum(known_cost_usd::numeric) filter(where status = 'failed'), 0)::text as failed_cost,
      coalesce(sum(charged_credits), 0)::text as charged, coalesce(sum(refunded_credits), 0)::text as refunded,
      coalesce(sum(held_credits), 0)::text as held from filtered
  ), providers as (
    select a->>'service' as service, a->>'endpoint' as endpoint, a->>'model' as model, a->>'basis' as basis,
      count(*)::int as calls, count(*) filter(where a->>'costUsd' is null)::int as unresolved,
      coalesce(sum((a->>'costUsd')::numeric), 0)::text as cost,
      coalesce(sum((a->'usage'->>'inputTokens')::numeric), 0)::text as input_tokens,
      coalesce(sum((a->'usage'->>'outputTokens')::numeric), 0)::text as output_tokens,
      coalesce(sum((a->'usage'->>'audioInputTokens')::numeric), 0)::text as audio_input_tokens,
      coalesce(sum((a->'usage'->>'seconds')::numeric), 0)::text as seconds,
      coalesce(sum((a->'usage'->>'firecrawlCredits')::numeric), 0)::text as firecrawl_credits
    from filtered cross join lateral jsonb_array_elements(charges) a group by 1,2,3,4
  ), paged as (
    select * from filtered order by ${order}, id limit ${options.all ? sql`null` : sql`${view.size}`}
    offset ${options.all ? sql`0` : sql`(least(${view.page}, greatest(1, ceil((select attempts from totals)::numeric / ${view.size})))::int - 1) * ${view.size}`}
  ) select row_to_json(totals) as summary,
      coalesce((select json_agg(providers order by cost::numeric desc, service, endpoint, model, basis) from providers), '[]') as providers,
      coalesce((select json_agg(paged order by ${order}, id) from paged), '[]') as items from totals`);
  const data = result.rows[0]!;
  const s = data.summary as Record<string, unknown>;
  const summary: CostSummary = { attempts: Number(s.attempts), ready: Number(s.ready), failed: Number(s.failed), active: Number(s.active), unknown: Number(s.unknown), knownCostUsd: String(s.cost), failedCostUsd: String(s.failed_cost), chargedCredits: Number(s.charged), refundedCredits: Number(s.refunded), heldCredits: Number(s.held) };
  const providers = (data.providers as Record<string, unknown>[]).map((p): CostProviderRow => ({ service: String(p.service), endpoint: String(p.endpoint), model: String(p.model), basis: String(p.basis), calls: Number(p.calls), unresolved: Number(p.unresolved), costUsd: String(p.cost), inputTokens: String(p.input_tokens), outputTokens: String(p.output_tokens), audioInputTokens: String(p.audio_input_tokens), seconds: String(p.seconds), firecrawlCredits: String(p.firecrawl_credits) }));
  return { items: (data.items as Record<string, unknown>[]).map(row), total: summary.attempts, page: clampPage(view.page, summary.attempts, view.size), size: view.size, summary, providers };
}
export async function knowledgeCostDetail(id: string): Promise<CostRunRow | null> {
  if (!isUuid(id)) return null;
  const result = await db().execute(sql`${base} select * from runs where id = ${id}::uuid`);
  return result.rows[0] ? row(result.rows[0]) : null;
}
