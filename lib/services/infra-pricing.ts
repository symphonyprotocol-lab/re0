/**
 * Our infrastructure rates (transfer, Blob storage, database storage), as
 * the console's 价格与促销 page edits them -- the same lock, revision and
 * `pricing.update` audit as the page's other settings. Rows are append-only
 * (`infra_cost_rates`): a save takes effect from the moment it commits, so
 * storage accrued before it keeps the old rate (`infraRateSegments`). With no
 * row, `DEFAULT_INFRA_COST_RATES` applies -- never zero. No process cache:
 * billing reads the rate in effect when it charges.
 */
import { and, asc, desc, gt, lt, lte, sql } from 'drizzle-orm';
import { defaultInfraCostRates, parseInfraCostRates, type InfraCostRates, type InfraCostRatesView } from '@/lib/domain/infra-cost';
import { db, schema, type Executor } from '@/lib/infra/db';
import { AdminInputError, audit } from '@/lib/services/admin';

type Row = typeof schema.infraCostRates.$inferSelect;

/** Numeric columns come back padded (`0.150000000000`); shown and compared as their plain value. */
const plain = (value: string) => {
  const [whole, fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return `${BigInt(whole!).toString()}${trimmed ? `.${trimmed}` : ''}`;
};

function view(row: Row): InfraCostRatesView {
  return {
    transferPerGb: plain(row.transferPerGb),
    blobStoragePerGbMonth: plain(row.blobStoragePerGbMonth),
    databaseStoragePerGbMonth: plain(row.databaseStoragePerGbMonth),
    databaseIndexFactor: plain(row.databaseIndexFactor),
    chunkRowBytes: row.chunkRowBytes,
    revision: row.id,
    effectiveFrom: row.effectiveFrom.toISOString(),
  };
}

/** The rates in effect at `at`. */
export async function infraCostRates(executor: Executor = db(), at = new Date()): Promise<InfraCostRatesView> {
  const [row] = await executor
    .select()
    .from(schema.infraCostRates)
    .where(lte(schema.infraCostRates.effectiveFrom, at))
    .orderBy(desc(schema.infraCostRates.effectiveFrom), desc(schema.infraCostRates.createdAt))
    .limit(1);
  return row ? view(row) : defaultInfraCostRates();
}

export interface RateSegment {
  from: number;
  to: number;
  rates: InfraCostRates;
}

/**
 * The rates over `[from, to)` (epoch ms), split where a save changed them:
 * each part priced at what applied then.
 */
export async function infraRateSegments(executor: Executor, from: number, to: number): Promise<RateSegment[]> {
  if (to <= from) return [];
  const start = await infraCostRates(executor, new Date(from));
  const later = await executor
    .select()
    .from(schema.infraCostRates)
    .where(and(gt(schema.infraCostRates.effectiveFrom, new Date(from)), lt(schema.infraCostRates.effectiveFrom, new Date(to))))
    .orderBy(asc(schema.infraCostRates.effectiveFrom), asc(schema.infraCostRates.createdAt));
  const segments: RateSegment[] = [];
  let at = from;
  let rates: InfraCostRates = start;
  for (const row of later) {
    const changed = row.effectiveFrom.getTime();
    if (changed > at) segments.push({ from: at, to: changed, rates });
    at = Math.max(at, changed);
    rates = view(row);
  }
  segments.push({ from: at, to, rates });
  return segments;
}

/** `PUT /api/admin/pricing` with `kind: 'infra_costs'`. */
export async function saveInfraCostRates(administratorId: string, input: Record<string, unknown>, now = new Date()): Promise<InfraCostRatesView> {
  const rates = parseInfraCostRates(input);
  if (!rates || typeof input.revision !== 'string') throw new AdminInputError('invalid_infra_costs');
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('pricing:infra_costs'))`);
    const before = await infraCostRates(tx, now);
    if (input.revision !== before.revision) throw new AdminInputError('pricing_conflict');
    const [row] = await tx
      .insert(schema.infraCostRates)
      .values({ ...rates, effectiveFrom: now, updatedBy: administratorId })
      .returning();
    const next = view(row!);
    await audit(tx, { administratorId, action: 'pricing.update', target: 'infra_costs', before, after: next });
    return next;
  });
}
