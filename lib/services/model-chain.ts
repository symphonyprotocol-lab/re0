/**
 * The stored lists of primary and backup entries (`model_chain`), written
 * only inside a transaction that holds the kind's console lock. Each write
 * also keeps `model_config.enabled` / `enabled_plan` on the first active
 * entry: for one release they mirror the list, so code from before lists
 * (and `activeSpace` in lib/services/embedding-space.ts) still reads the
 * primary (design Q9).
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { ModelKind } from '@/lib/constants';
import { chainAudience, type ChainAudience } from '@/lib/domain/model-failover';
import { schema, type Executor } from '@/lib/infra/db';

export interface ChainItem { configId: string; active: boolean }
export type ChainRow = typeof schema.modelChain.$inferSelect;

/** Serializes every change to a kind's entries and lists (the same lock `enable` always took). */
export async function lockKind(tx: Executor, kind: ModelKind): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`model-config:${kind}`}))`);
}

export async function readChain(tx: Executor, kind: ModelKind, audience: ChainAudience): Promise<ChainRow[]> {
  return tx.select().from(schema.modelChain)
    .where(and(eq(schema.modelChain.kind, kind), eq(schema.modelChain.audience, audience)))
    .orderBy(asc(schema.modelChain.position));
}

export async function readAllChains(tx: Executor): Promise<ChainRow[]> {
  return tx.select().from(schema.modelChain).orderBy(asc(schema.modelChain.kind), asc(schema.modelChain.audience), asc(schema.modelChain.position));
}

/** Replaces a list (positions from 0 in the given order) and moves the mirror to its first active entry. */
export async function writeChain(tx: Executor, kind: ModelKind, audience: ChainAudience, items: readonly ChainItem[], administratorId: string | null, now = new Date()): Promise<void> {
  /* Delete and insert: shuffling positions in place would trip the unique (kind, audience, position) index midway. */
  await tx.delete(schema.modelChain).where(and(eq(schema.modelChain.kind, kind), eq(schema.modelChain.audience, audience)));
  if (items.length > 0) {
    await tx.insert(schema.modelChain).values(items.map((item, position) => ({
      kind, audience, modelConfigId: item.configId, position, active: item.active, updatedBy: administratorId, updatedAt: now,
    })));
  }
  await syncPrimary(tx, kind, audience, administratorId, now);
}

/** `enabled` (`enabled_plan` for the Plan list) on the list's first active entry and on nothing else of the kind. */
export async function syncPrimary(tx: Executor, kind: ModelKind, audience: ChainAudience, administratorId: string | null, now = new Date()): Promise<void> {
  const field = audience === 'plan' ? 'enabledPlan' : 'enabled';
  const [first] = await tx.select({ id: schema.modelChain.modelConfigId }).from(schema.modelChain)
    .where(and(eq(schema.modelChain.kind, kind), eq(schema.modelChain.audience, audience), eq(schema.modelChain.active, true)))
    .orderBy(asc(schema.modelChain.position)).limit(1);
  const [current] = await tx.select({ id: schema.modelConfig.id }).from(schema.modelConfig)
    .where(and(eq(schema.modelConfig.kind, kind), eq(schema.modelConfig[field], true))).limit(1);
  if (current?.id === first?.id) return;
  if (current) await tx.update(schema.modelConfig).set({ [field]: false, updatedBy: administratorId, updatedAt: now }).where(eq(schema.modelConfig.id, current.id));
  if (first) await tx.update(schema.modelConfig).set({ [field]: true, updatedBy: administratorId, updatedAt: now }).where(eq(schema.modelConfig.id, first.id));
}

/** Whether an entry sits in any list: then, like an enabled entry, its model and endpoint are frozen. */
export async function inAnyChain(tx: Executor, configId: string): Promise<boolean> {
  const [row] = await tx.select({ id: schema.modelChain.id }).from(schema.modelChain).where(eq(schema.modelChain.modelConfigId, configId)).limit(1);
  return Boolean(row);
}

/** The lists an entry is in, for the console. */
export async function chainsOf(tx: Executor, configIds: readonly string[]): Promise<ChainRow[]> {
  if (configIds.length === 0) return [];
  return tx.select().from(schema.modelChain).where(inArray(schema.modelChain.modelConfigId, [...configIds]));
}

export { chainAudience };
