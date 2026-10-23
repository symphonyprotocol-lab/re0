/**
 * The expert thresholds in force, and their history. review-visibility-
 * proposal.md 5.3; rules in lib/domain/expert-thresholds.ts.
 *
 * Append-only: a save mints a row in `review_config`, the newest row is in
 * force, and an empty table means the defaults. A read failure falls back to
 * the defaults, logged -- an application must still be judged, and the
 * defaults are what the code shipped with. The table kept its name from the
 * public-review era; the expert thresholds are what is left in it.
 */
import { desc } from 'drizzle-orm';
import { recordAudit } from '@/lib/application/administration/audit';
import { normalizeReason } from '@/lib/domain/admin';
import {
  DEFAULT_EXPERT_THRESHOLDS,
  EXPERT_THRESHOLD_KEYS,
  validateExpertThresholds,
  type ExpertThresholdKey,
  type ExpertThresholds,
} from '@/lib/domain/expert-thresholds';
import { uuidv7 } from '@/lib/domain/id';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export interface ActiveExpertThresholds extends ExpertThresholds {
  /** Null when the defaults are in force because nothing was ever saved. */
  configId: string | null;
  createdAt: Date | null;
}

export interface ExpertThresholdsRow extends ExpertThresholds {
  id: string;
  createdAt: Date;
}

export interface ExpertThresholdsConfiguration {
  current: ActiveExpertThresholds;
  history: ExpertThresholdsRow[];
}

function thresholdsOf(row: Record<ExpertThresholdKey, number>): ExpertThresholds {
  return Object.fromEntries(EXPERT_THRESHOLD_KEYS.map((key) => [key, row[key]])) as ExpertThresholds;
}

export async function activeExpertThresholds(): Promise<ActiveExpertThresholds> {
  let row: ExpertThresholdsRow | undefined;
  try {
    [row] = await db().select().from(schema.reviewConfig).orderBy(desc(schema.reviewConfig.createdAt)).limit(1);
  } catch (error) {
    console.error(`expert thresholds unreadable, using defaults: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  if (!row) return { ...DEFAULT_EXPERT_THRESHOLDS, configId: null, createdAt: null };
  return { ...thresholdsOf(row), configId: row.id, createdAt: row.createdAt };
}

export async function readExpertThresholdsConfiguration(): Promise<ExpertThresholdsConfiguration> {
  const history = await db().select().from(schema.reviewConfig).orderBy(desc(schema.reviewConfig.createdAt)).limit(40);
  const newest = history[0];
  return {
    current: newest
      ? { ...thresholdsOf(newest), configId: newest.id, createdAt: newest.createdAt }
      : { ...DEFAULT_EXPERT_THRESHOLDS, configId: null, createdAt: null },
    history: history.map((row) => ({ ...thresholdsOf(row), id: row.id, createdAt: row.createdAt })),
  };
}

export interface UpdateExpertThresholdsInput {
  actor: { administratorId: string; email: string; clientAddress?: string | null };
  /** Every key; a missing one is refused, never defaulted. */
  values: Partial<Record<ExpertThresholdKey, number>>;
  reason: string;
}

/** Throws `ExpertThresholdsRefused` (domain) or `AdminChangeRefused` for a missing reason. */
export async function updateExpertThresholds(input: UpdateExpertThresholdsInput): Promise<{ configId: string }> {
  const reason = normalizeReason(input.reason);
  const thresholds = validateExpertThresholds(input.values);
  const before = await activeExpertThresholds();

  const configId = uuidv7();
  await db().insert(schema.reviewConfig).values({ id: configId, ...thresholds });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'review_config.update',
    targetType: 'review_config',
    targetId: configId,
    reason,
    beforeValue: thresholdsOf(before),
    afterValue: thresholds,
    clientAddress: input.actor.clientAddress,
    result: 'success',
  });

  return { configId };
}
