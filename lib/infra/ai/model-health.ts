/**
 * Which console entries are cooling (lib/domain/model-failover.ts), shared
 * by every instance through `model_health`. An instance marks a failure in
 * its own memory at once and writes it to the table without holding up the
 * request; once the write lands, the table is the only truth again. Each
 * instance re-reads the table at most every ten seconds, so another one
 * meets a model that ran out of quota at most once before skipping it, and
 * follows a probe or an administrator clearing it within ten seconds.
 */
import { eq, sql } from 'drizzle-orm';
import { after } from 'next/server';
import type { ModelKind } from '@/lib/constants';
import { afterFailure, HEALTH_CACHE_MS, HEALTHY, isCooling, successClears, type Failure, type Health, type SwitchingClass } from '@/lib/domain/model-failover';
import { db, schema } from '@/lib/infra/db';

/** This instance's own changes not yet in the table (or that failed to reach it), with when they were made. */
const local = new Map<string, { health: Health; at: Date }>();
/** The table as last read, with each row's `updated_at`. */
let stored: { at: number; rows: Map<string, { health: Health; updatedAt: Date }> } | null = null;

/** Tests, and the console after it clears a cooldown. */
export function forgetHealthCache(): void {
  local.clear();
  stored = null;
}

type Row = typeof schema.modelHealth.$inferSelect;
function fromRow(row: Row): { health: Health; updatedAt: Date } {
  return {
    health: {
      state: row.state, reason: row.reason ?? null, coolingUntil: row.coolingUntil, consecutiveFailures: row.consecutiveFailures,
      lastFailureAt: row.lastFailureAt, lastSuccessAt: row.lastSuccessAt, lastErrorCode: row.lastErrorCode,
    },
    updatedAt: row.updatedAt,
  };
}

/** The newer of this instance's unwritten change and the table's row: a probe or a clear elsewhere, written after it, wins. */
function merged(mine: { health: Health; at: Date } | undefined, theirs: { health: Health; updatedAt: Date } | undefined): Health {
  if (!mine) return theirs?.health ?? HEALTHY;
  if (!theirs) return mine.health;
  return theirs.updatedAt.getTime() >= mine.at.getTime() ? theirs.health : mine.health;
}

/** After a write lands: the table's row is this instance's view, unless a newer change of its own is still pending. */
function landed(configId: string, at: Date, row: Row | undefined): void {
  if (local.get(configId)?.at === at) local.delete(configId);
  if (row && stored) stored.rows.set(configId, fromRow(row));
}

async function storedHealth(now: Date): Promise<Map<string, { health: Health; updatedAt: Date }>> {
  if (stored && now.getTime() - stored.at < HEALTH_CACHE_MS) return stored.rows;
  if (!process.env.DATABASE_URL) return new Map();
  try {
    const rows = await db().select().from(schema.modelHealth);
    stored = { at: now.getTime(), rows: new Map(rows.map((row) => [row.modelConfigId, fromRow(row)])) };
  } catch {
    /* Choosing a model must never fail on its health: without the table, this instance's own view. */
    stored = { at: now.getTime(), rows: stored?.rows ?? new Map() };
  }
  return stored.rows;
}

export async function healthSnapshot(now = new Date()): Promise<Map<string, Health>> {
  const rows = await storedHealth(now);
  const ids = new Set([...rows.keys(), ...local.keys()]);
  return new Map([...ids].map((id) => [id, merged(local.get(id), rows.get(id))]));
}

export async function healthOf(configId: string, now = new Date()): Promise<Health> {
  return (await healthSnapshot(now)).get(configId) ?? HEALTHY;
}

interface Subject { configId: string | null; kind: ModelKind; name: string; model: string }

/** Background writes: failing over must not wait for the table. Tests await them through `settleHealthWrites`. */
const pending = new Set<Promise<void>>();
function background(work: () => Promise<void>): void {
  const task = work().catch((error: unknown) => console.warn(`model health write failed: ${error instanceof Error ? error.message : 'unknown'}`));
  pending.add(task);
  void task.finally(() => pending.delete(task));
  /* Inside a request, the platform keeps the function alive until the write lands; outside one (cron, scripts) there is nothing to extend. */
  try { after(task); } catch { /* not in a request scope */ }
}
export async function settleHealthWrites(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

async function systemAudit(action: 'model.cooldown' | 'model.recover', target: string, after: unknown): Promise<void> {
  await db().insert(schema.adminAudit).values({ administratorId: null, action, target, after });
}

/** A switching failure of an entry: cools it when the rules say so, and records the start of a cooldown. */
export async function reportFailure(subject: Subject, failure: Failure & { kind: SwitchingClass }, now = new Date()): Promise<Health> {
  if (!subject.configId) return HEALTHY;
  const configId = subject.configId;
  const previous = await healthOf(configId, now);
  const next = afterFailure(previous, failure, now);
  local.set(configId, { health: next, at: now });
  const started = next.state === 'cooling' && !isCooling(previous, now);
  if (started) {
    console.warn(JSON.stringify({ event: 'model_cooldown', kind: subject.kind, configId, name: subject.name, model: subject.model, reason: next.reason, status: failure.status, until: next.coolingUntil?.toISOString() }));
  }
  if (!process.env.DATABASE_URL) return next;
  background(async () => {
    const stillCooling = sql`(${schema.modelHealth.state} = 'cooling' and ${schema.modelHealth.coolingUntil} > ${now})`;
    const [row] = await db()
      .insert(schema.modelHealth)
      .values({ modelConfigId: configId, ...next, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.modelHealth.modelConfigId,
        set: {
          /* Another instance's longer cooldown stands; a first transient failure never ends one. */
          state: sql`case when excluded.state = 'cooling' or ${stillCooling} then 'cooling' else 'ok' end`,
          /* Nor does a passing failure rename a cooldown only a probe clears (quota cooling would turn into server cooling a request may end). */
          reason: sql`case when ${stillCooling} and (excluded.state <> 'cooling' or ${schema.modelHealth.reason} in ('quota', 'auth', 'model_missing')) then ${schema.modelHealth.reason} else excluded.reason end`,
          coolingUntil: sql`case when excluded.state = 'cooling' then greatest(${schema.modelHealth.coolingUntil}, excluded.cooling_until) else ${schema.modelHealth.coolingUntil} end`,
          consecutiveFailures: sql`greatest(${schema.modelHealth.consecutiveFailures}, excluded.consecutive_failures)`,
          lastFailureAt: sql`excluded.last_failure_at`,
          lastErrorCode: sql`excluded.last_error_code`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning();
    landed(configId, now, row);
    if (started) {
      await db().insert(schema.modelHealthEvent).values({ modelConfigId: configId, event: 'cooling', reason: next.reason, coolingUntil: next.coolingUntil, createdAt: now });
      await systemAudit('model.cooldown', configId, { kind: subject.kind, name: subject.name, model: subject.model, reason: next.reason, status: failure.status, coolingUntil: next.coolingUntil });
    }
  });
  return next;
}

/**
 * A successful call (or probe): clears a cooldown the rules let it clear.
 * Cheap on the hot path -- the table is written only when this instance
 * believes the entry is not healthy.
 */
export async function reportSuccess(subject: Subject, now = new Date(), source: 'request' | 'probe' = 'request'): Promise<void> {
  if (!subject.configId) return;
  const configId = subject.configId;
  const previous = await healthOf(configId, now);
  if (!successClears(previous, now, source)) {
    if (source === 'probe' && process.env.DATABASE_URL) {
      await db().update(schema.modelHealth).set({ lastSuccessAt: now, lastProbeAt: now }).where(eq(schema.modelHealth.modelConfigId, configId));
    }
    return;
  }
  local.set(configId, { health: { ...HEALTHY, lastFailureAt: previous.lastFailureAt, lastSuccessAt: now }, at: now });
  if (!process.env.DATABASE_URL) return;
  const write = async () => {
    const [before] = await db().select().from(schema.modelHealth).where(eq(schema.modelHealth.modelConfigId, configId)).limit(1);
    if (!before) { landed(configId, now, undefined); return; }
    const cleared = await db()
      .update(schema.modelHealth)
      .set({ state: 'ok', reason: null, coolingUntil: null, consecutiveFailures: 0, lastSuccessAt: now, updatedAt: now, ...(source === 'probe' ? { lastProbeAt: now } : {}) })
      .where(source === 'probe'
        ? eq(schema.modelHealth.modelConfigId, configId)
        : sql`${schema.modelHealth.modelConfigId} = ${configId} and (${schema.modelHealth.state} = 'ok' or ${schema.modelHealth.coolingUntil} is null or ${schema.modelHealth.coolingUntil} <= ${now} or ${schema.modelHealth.reason} in ('rate_limit', 'server', 'timeout'))`)
      .returning();
    /* Not cleared (a quota cooldown another instance set): the table's row, still cooling, is what this instance follows. */
    const [after] = cleared.length > 0 ? cleared : await db().select().from(schema.modelHealth).where(eq(schema.modelHealth.modelConfigId, configId)).limit(1);
    landed(configId, now, after);
    if (cleared.length > 0 && before.state === 'cooling') {
      console.info(JSON.stringify({ event: 'model_recovered', kind: subject.kind, configId, name: subject.name, model: subject.model, reason: before.reason, source }));
      await db().insert(schema.modelHealthEvent).values({ modelConfigId: configId, event: 'recovered', reason: before.reason, createdAt: now });
      await systemAudit('model.recover', configId, { kind: subject.kind, name: subject.name, model: subject.model, reason: before.reason, source });
    }
  };
  /* A probe answers the console (or the cron) only once the table says so; a request never waits. */
  if (source === 'probe') await write();
  else background(write);
}

/** "解除冷却": an administrator says the entry is fine again. Answers whether it was cooling. */
export async function clearHealth(configId: string, now = new Date()): Promise<boolean> {
  const [before] = await db().select().from(schema.modelHealth).where(eq(schema.modelHealth.modelConfigId, configId)).limit(1);
  local.delete(configId);
  stored = null;
  if (!before) return false;
  /* `updated_at` later than any instance's own failure: each follows the table within ten seconds. */
  await db()
    .update(schema.modelHealth)
    .set({ state: 'ok', reason: null, coolingUntil: null, consecutiveFailures: 0, lastSuccessAt: now, updatedAt: now })
    .where(eq(schema.modelHealth.modelConfigId, configId));
  const wasCooling = before.state === 'cooling';
  if (wasCooling) await db().insert(schema.modelHealthEvent).values({ modelConfigId: configId, event: 'manual_clear', reason: before.reason, createdAt: now });
  return wasCooling;
}
