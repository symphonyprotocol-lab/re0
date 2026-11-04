import { sql, type SQL } from 'drizzle-orm';
import { financeRange } from '@/lib/domain/admin-finance';
import { clampPage, isUuid, likePattern } from '@/lib/domain/list';
import type { ModelCallsView } from '@/lib/domain/model-calls';
import { db, schema } from '@/lib/infra/db';

export type ModelCallDetail = typeof schema.modelCall.$inferSelect & { userName: string | null; userEmail: string | null };
export interface CallTotals {
  calls: number; succeeded: number; failed: number; aborted: number; unknown: number;
  inputTokens: number; outputTokens: number; averageMs: number | null;
  knownCostUsd: string; estimatedCostUsd: string; unpriced: number;
}
export interface ModelCallGroup extends CallTotals { model: string; endpoint: string | null; audience: 'free' | 'plan' | null }
const base = sql`with calls as (
  select c.*, u.name as user_name, u.email as user_email
  from model_call c left join "user" u on u.id = c.user_id where c.kind = 'generation'
)`;
const totals = sql`count(*)::int as calls,
  count(*) filter(where status = 'succeeded')::int as succeeded,
  count(*) filter(where status = 'failed')::int as failed,
  count(*) filter(where status = 'aborted')::int as aborted,
  count(*) filter(where status = 'unknown')::int as unknown,
  coalesce(sum(input_tokens), 0)::text as input_tokens,
  coalesce(sum(output_tokens), 0)::text as output_tokens,
  round(avg(duration_ms))::int as average_ms,
  coalesce(sum(cost_usd::numeric) filter(where cost_basis <> 'estimated'), 0)::text as known_cost_usd,
  coalesce(sum(cost_usd::numeric) filter(where cost_basis = 'estimated'), 0)::text as estimated_cost_usd,
  count(*) filter(where cost_usd is null)::int as unpriced`;
function conditions(view: ModelCallsView): SQL {
  const clauses: SQL[] = [];
  if (view.status !== 'all') clauses.push(sql`status = ${view.status}`);
  if (view.audience !== 'all') clauses.push(view.audience === 'unknown' ? sql`audience is null` : sql`audience = ${view.audience}`);
  if (view.purpose !== 'all') clauses.push(sql`purpose = ${view.purpose}`);
  if (view.model) clauses.push(sql`model = ${view.model}`);
  if (view.q) {
    const q = likePattern(view.q);
    clauses.push(sql`(model ilike ${q} or config_name ilike ${q} or user_name ilike ${q} or user_email ilike ${q} or user_id::text ilike ${q} or id::text ilike ${q} or request_id ilike ${q})`);
  }
  const range = financeRange(view);
  if (range) clauses.push(sql`created_at >= ${new Date(range.start).toISOString()}::timestamptz and created_at < ${new Date(range.end).toISOString()}::timestamptz`);
  return clauses.length ? sql`where ${sql.join(clauses, sql` and `)}` : sql``;
}
function summary(r: Record<string, unknown>): CallTotals {
  return { calls: Number(r.calls), succeeded: Number(r.succeeded), failed: Number(r.failed), aborted: Number(r.aborted), unknown: Number(r.unknown), inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), averageMs: r.average_ms === null ? null : Number(r.average_ms), knownCostUsd: String(r.known_cost_usd), estimatedCostUsd: String(r.estimated_cost_usd), unpriced: Number(r.unpriced) };
}
function row(r: Record<string, unknown>): ModelCallDetail {
  return {
    id: String(r.id), kind: 'generation', model: String(r.model), configId: r.config_id as string | null,
    configName: r.config_name as string | null, userId: r.user_id as string | null, audience: r.audience as ModelCallDetail['audience'],
    purpose: r.purpose as ModelCallDetail['purpose'], status: r.status as ModelCallDetail['status'], durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    usageKnown: Boolean(r.usage_known), endpoint: r.endpoint as string | null, requestId: r.request_id as string | null, errorCode: r.error_code as string | null,
    costUsd: r.cost_usd as string | null, costBasis: r.cost_basis as ModelCallDetail['costBasis'], rate: r.rate as ModelCallDetail['rate'], priceRevision: r.price_revision as string | null,
    inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), seconds: Number(r.seconds), createdAt: new Date(String(r.created_at)),
    userName: r.user_name as string | null, userEmail: r.user_email as string | null,
  };
}
export async function modelCallReport(view: ModelCallsView, options: { all?: boolean } = {}) {
  const order = { newest: sql`created_at desc`, oldest: sql`created_at asc`, 'cost-high': sql`cost_usd::numeric desc nulls last, created_at desc`, 'cost-low': sql`cost_usd::numeric asc nulls last, created_at desc` }[view.sort];
  const result = await db().execute(sql`${base}, filtered as (select * from calls ${conditions(view)}), totals as (
    select ${totals} from filtered
  ), grouped as (
    select model, endpoint, audience, ${totals} from filtered group by model, endpoint, audience
  ), paged as (
    select * from filtered order by ${order}, id limit ${options.all ? sql`null` : sql`${view.size}`}
    offset ${options.all ? sql`0` : sql`(least(${view.page}, greatest(1, ceil((select calls from totals)::numeric / ${view.size})))::int - 1) * ${view.size}`}
  ) select row_to_json(totals) as summary,
    coalesce((select json_agg(grouped order by calls desc, model, endpoint, audience) from grouped), '[]') as models,
    coalesce((select json_agg(paged order by ${order}, id) from paged), '[]') as items from totals`);
  const data = result.rows[0]!;
  const s = summary(data.summary as Record<string, unknown>);
  return {
    summary: s,
    models: (data.models as Record<string, unknown>[]).map((r): ModelCallGroup => ({ ...summary(r), model: String(r.model), endpoint: r.endpoint as string | null, audience: r.audience as ModelCallGroup['audience'] })),
    items: (data.items as Record<string, unknown>[]).map(row), total: s.calls,
    page: clampPage(view.page, s.calls, view.size), size: view.size,
  };
}
export async function modelCallDetail(id: string): Promise<ModelCallDetail | null> {
  if (!isUuid(id)) return null;
  const result = await db().execute(sql`${base} select * from calls where id = ${id}::uuid`);
  return result.rows[0] ? row(result.rows[0]) : null;
}
