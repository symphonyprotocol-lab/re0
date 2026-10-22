/**
 * The review rules in force, and their history. review-visibility-
 * proposal.md 6.1; rules in lib/domain/auto-review.ts.
 *
 * Append-only like retrieval's tunables: a save mints a row, the newest row
 * is in force, and an empty table means the defaults. A read failure falls
 * back to the defaults, logged -- a submission must still be decided, and
 * the defaults are what the code shipped with.
 */
import { desc } from 'drizzle-orm';
import { recordAudit } from '@/lib/application/administration/audit';
import { normalizeReason } from '@/lib/domain/admin';
import {
  DEFAULT_REVIEW_RULES,
  REVIEW_RULE_KEYS,
  validateReviewRules,
  type ReviewRuleKey,
  type ReviewRules,
} from '@/lib/domain/auto-review';
import { uuidv7 } from '@/lib/domain/id';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export interface ActiveReviewRules extends ReviewRules {
  /** Null when the defaults are in force because nothing was ever saved. */
  configId: string | null;
  createdAt: Date | null;
}

export interface ReviewRulesRow extends ReviewRules {
  id: string;
  createdAt: Date;
}

export interface ReviewRulesConfiguration {
  current: ActiveReviewRules;
  history: ReviewRulesRow[];
}

function rulesOf(row: Record<ReviewRuleKey, number>): ReviewRules {
  return Object.fromEntries(REVIEW_RULE_KEYS.map((key) => [key, row[key]])) as ReviewRules;
}

export async function activeReviewRules(): Promise<ActiveReviewRules> {
  let row: ReviewRulesRow | undefined;
  try {
    [row] = await db().select().from(schema.reviewConfig).orderBy(desc(schema.reviewConfig.createdAt)).limit(1);
  } catch (error) {
    console.error(`review rules unreadable, using defaults: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  if (!row) return { ...DEFAULT_REVIEW_RULES, configId: null, createdAt: null };
  return { ...rulesOf(row), configId: row.id, createdAt: row.createdAt };
}

export async function readReviewRulesConfiguration(): Promise<ReviewRulesConfiguration> {
  const history = await db().select().from(schema.reviewConfig).orderBy(desc(schema.reviewConfig.createdAt)).limit(40);
  const newest = history[0];
  return {
    current: newest
      ? { ...rulesOf(newest), configId: newest.id, createdAt: newest.createdAt }
      : { ...DEFAULT_REVIEW_RULES, configId: null, createdAt: null },
    history,
  };
}

export interface UpdateReviewRulesInput {
  actor: { administratorId: string; email: string; clientAddress?: string | null };
  /** Every key; a missing one is refused, never defaulted. */
  values: Partial<Record<ReviewRuleKey, number>>;
  reason: string;
}

/** Throws `ReviewRulesRefused` (domain) or `AdminChangeRefused` for a missing reason. */
export async function updateReviewRules(input: UpdateReviewRulesInput): Promise<{ configId: string }> {
  const reason = normalizeReason(input.reason);
  const rules = validateReviewRules(input.values);
  const before = await activeReviewRules();

  const configId = uuidv7();
  await db().insert(schema.reviewConfig).values({ id: configId, ...rules });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'review_config.update',
    targetType: 'review_config',
    targetId: configId,
    reason,
    beforeValue: rulesOf(before),
    afterValue: rules,
    clientAddress: input.actor.clientAddress,
    result: 'success',
  });

  return { configId };
}
