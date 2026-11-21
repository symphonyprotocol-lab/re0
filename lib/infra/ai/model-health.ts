/**
 * Which console entries are cooling (lib/domain/model-failover.ts), shared
 * by every instance through `model_health`. An instance marks a failure in
 * its own memory at once and writes it to the table without holding up the
 * request; it re-reads the table at most every ten seconds, so another
 * instance meets a model that ran out of quota at most once before skipping it.
 */
import { eq, sql } from 'drizzle-orm';
import type { ModelKind } from '@/lib/constants';
import { afterFailure, HEALTH_CACHE_MS, HEALTHY, isCooling, successClears, type Failure, type Health, type SwitchingClass } from '@/lib/domain/model-failover';
import { db, schema } from '@/lib/infra/db';

const local = new Map<string, Health>();
let stored: { at: number; rows: Map<string, Health> } | null = null;

/** Tests, and the console after it clears a cooldown. */
export function forgetHealthCache(): void {
  local.clear();
  stored = null;
}

type Row = typeof schema.modelHealth.$inferSelect;
function fromRow(row: Row): Health {
  return {
    state: row.state, reason: row.reason ?? null, coolingUntil: row.coolingUntil, consecutiveFailures: row.consecutiveFailures,
    lastFailureAt: row.lastFailureAt, lastSuccessAt: row.lastSuccessAt, lastErrorCode: row.lastErrorCode,
  };
}

const later = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b);

/** This instance's view and the table's, the more cautious of the two. */
function merged(mine: Health | undefined, theirs: Health | undefined, now: Date): Health {
  if (!mine) return theirs ?? HEALTHY;
  if (!theirs) return mine;
  const cooling = [mine, theirs].filter((health) => isCooling(health, now));
  const lead = cooling.sort((a, b) => b.coolingUntil!.getTime() - a.coolingUntil!.getTime())[0];
  /* A success seen here after the table's failure wins over a stale read of it, unless that failure still cools. */
  const base = lead ?? ((mine.lastSuccessAt ?? new Date(0)) >= (theirs.lastFailureAt ?? new Date(0)) ? mine : theirs);
  return {
    ...base,
    consecutiveFailures: lead ? Math.max(mine.consecutiveFailures, theirs.consecutiveFailures) : base.consecutiveFailures,
    lastFailureAt: later(mine.lastFailureAt, theirs.lastFailureAt),
    lastSuccessAt: later(mine.lastSuccessAt, theirs.lastSuccessAt),
  };
}

async function storedHealth(now: Date): Promise<Map<string, Health>> {
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
  return new Map([...ids].map((id) => [id, merged(local.get(id), rows.get(id), now)]));
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
  local.set(configId, next);
  const started = next.state === 'cooling' && !isCooling(previous, now);
  if (started) {
    console.warn(JSON.stringify({ event: 'model_cooldown', kind: subject.kind, configId, name: subject.name, model: subject.model, reason: next.reason, status: failure.status, until: next.coolingUntil?.toISOString() }));
  }
  if (!process.env.DATABASE_URL) return next;
  background(async () => {
    await db()
      .insert(schema.modelHealth)
      .values({ modelConfigId: configId, ...next, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.modelHealth.modelConfigId,
        set: {
          /* Another instance's longer cooldown stands; a first transient failure never ends one. */
          state: sql`case when excluded.state = 'cooling' or (${schema.modelHealth.state} = 'cooling' and ${schema.modelHealth.coolingUntil} > ${now}) then 'cooling' else 'ok' end`,
          reason: sql`case when excluded.state <> 'cooling' and ${schema.modelHealth.state} = 'cooling' and ${schema.modelHealth.coolingUntil} > ${now} then ${schema.modelHealth.reason} else excluded.reason end`,
          coolingUntil: sql`case when excluded.state = 'cooling' then greatest(${schema.modelHealth.coolingUntil}, excluded.cooling_until) else ${schema.modelHealth.coolingUntil} end`,
          consecutiveFailures: sql`greatest(${schema.modelHealth.consecutiveFailures}, excluded.consecutive_failures)`,
          lastFailureAt: sql`excluded.last_failure_at`,
          lastErrorCode: sql`excluded.last_error_code`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
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
  local.set(configId, { ...HEALTHY, lastFailureAt: previous.lastFailureAt, lastSuccessAt: now });
  stored?.rows.delete(configId);
  if (!process.env.DATABASE_URL) return;
  const write = async () => {
    const [before] = await db().select().from(schema.modelHealth).where(eq(schema.modelHealth.modelConfigId, configId)).limit(1);
    if (!before) return;
    const cleared = await db()
      .update(schema.modelHealth)
      .set({ state: 'ok', reason: null, coolingUntil: null, consecutiveFailures: 0, lastSuccessAt: now, updatedAt: now, ...(source === 'probe' ? { lastProbeAt: now } : {}) })
      .where(source === 'probe'
        ? eq(schema.modelHealth.modelConfigId, configId)
        : sql`${schema.modelHealth.modelConfigId} = ${configId} and (${schema.modelHealth.state} = 'ok' or ${schema.modelHealth.coolingUntil} is null or ${schema.modelHealth.coolingUntil} <= ${now} or ${schema.modelHealth.reason} in ('rate_limit', 'server', 'timeout'))`)
      .returning({ id: schema.modelHealth.modelConfigId });
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
  await db()
    .update(schema.modelHealth)
    .set({ state: 'ok', reason: null, coolingUntil: null, consecutiveFailures: 0, updatedAt: now })
    .where(eq(schema.modelHealth.modelConfigId, configId));
  const wasCooling = before.state === 'cooling';
  if (wasCooling) await db().insert(schema.modelHealthEvent).values({ modelConfigId: configId, event: 'manual_clear', reason: before.reason, createdAt: now });
  return wasCooling;
}
