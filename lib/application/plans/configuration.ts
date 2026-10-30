/**
 * Use cases behind the console's subscription configuration screen: read the
 * catalogue, and mint a new Plan Version.
 *
 * There is deliberately no update and no delete. A Plan Version is immutable
 * (architecture.md 6.1, requirement.md 4.3): a price or ceiling change is a new
 * row, existing subscriptions keep billing against the row they were sold, and
 * history is never rewritten. "Edit plan" on that screen means "supersede",
 * which is why the only mutation here is an insert.
 *
 * requirement.md 5.3 makes this a high-risk action: it takes a reason and
 * writes the operator, the target, the values before and after, the result, the
 * time and a summary of the network origin to the audit log.
 */
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@/lib/domain/id';
import {
  PLAN_TIER_IDS,
  PlanChangeRefused,
  capabilitiesFor,
  isSamePlanVersion,
  tierHasEntitlements,
  parsePlanVersionDraft,
  readCapabilities,
  type PlanCapabilities,
  type PlanTierId,
  type PlanVersionInput,
} from '@/lib/domain/plans';
import { normalizeReason } from '@/lib/domain/admin';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { recordAudit } from '@/lib/application/administration/audit';

export interface PlanVersionRow {
  id: string;
  planId: PlanTierId;
  priceMinor: number;
  currency: string;
  monthlyCalls: number;
  apiKeyLimit: number;
  /** asset-build-billing.md 3.3. */
  buildBaseCalls: number;
  buildTokensPerCall: number;
  buildPagesPerCall: number;
  capabilities: PlanCapabilities;
  createdAt: Date;
  /** Subscriptions still billing against this row -- what superseding leaves behind. */
  subscriptions: number;
  /** The newest version of its tier: what a new subscription is sold. */
  isLive: boolean;
}

export interface PlanTierView {
  id: PlanTierId;
  /** Null only if the tier has no version at all, which the seed rules out. */
  live: PlanVersionRow | null;
}

export interface PlanConfiguration {
  tiers: PlanTierView[];
  /** Every version, newest first, across all tiers. */
  history: PlanVersionRow[];
}

/**
 * Ordered by `created_at` and then by id: the definition of "live".
 *
 * The timestamp defaults to `now()`, which is the transaction's clock, so two
 * versions minted in one transaction tie on it and "which one is live" must not
 * be left to the planner. Ids are UUIDv7, so the tiebreak is still time order
 * rather than an arbitrary one.
 *
 * Exported because signup picks a workspace's first Free version inside its own
 * transaction and must reach the same row this screen calls live. It used to
 * carry its own `created_at DESC` and no tiebreak, which meant a tie could sell
 * a new account an allowance the console said it should not have.
 */
export const PLAN_VERSION_NEWEST_FIRST = [
  desc(schema.planVersion.createdAt),
  desc(schema.planVersion.id),
] as const;

/** The version a new subscription of this tier is sold. */
export async function currentPlanVersion(planId: PlanTierId): Promise<PlanVersionRow | null> {
  const [row] = await db()
    .select()
    .from(schema.planVersion)
    .where(eq(schema.planVersion.planId, planId))
    .orderBy(...PLAN_VERSION_NEWEST_FIRST)
    .limit(1);
  if (!row) return null;
  return { ...toRow(row, await countSubscriptionsOn(row.id)), isLive: true };
}

/** Subscriptions still billing against one version -- what superseding leaves behind. */
async function countSubscriptionsOn(planVersionId: string): Promise<number> {
  const [row] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.subscription)
    .where(eq(schema.subscription.planVersionId, planVersionId));
  return row?.count ?? 0;
}

type RawVersion = typeof schema.planVersion.$inferSelect;

function toRow(row: RawVersion, subscriptions: number): PlanVersionRow {
  const planId = row.planId as PlanTierId;
  return {
    id: row.id,
    planId,
    priceMinor: row.priceMinor,
    currency: row.currency,
    monthlyCalls: row.monthlyCalls,
    apiKeyLimit: row.apiKeyLimit,
    buildBaseCalls: row.buildBaseCalls,
    buildTokensPerCall: row.buildTokensPerCall,
    buildPagesPerCall: row.buildPagesPerCall,
    capabilities: readCapabilities(row.capabilities),
    createdAt: row.createdAt,
    subscriptions,
    isLive: false,
  };
}

/**
 * The whole catalogue: the live version of each tier, and every version behind
 * it with the subscriptions it still bills.
 *
 * The count matters more than it looks: it is the difference between "this old
 * row is history" and "this old row is what 46 workspaces are being charged",
 * and only one of those is safe to stop thinking about.
 */
export async function listPlanConfiguration(): Promise<PlanConfiguration> {
  const database = db();

  /*
   * The tier's display name is not read: the console labels the cards from its
   * own dictionary, so `plan.name` would be an English string sitting under a
   * Chinese heading. `plan` exists here for the foreign key, not for copy.
   */
  const versions = await database
    .select()
    .from(schema.planVersion)
    .where(inArray(schema.planVersion.planId, [...PLAN_TIER_IDS]))
    .orderBy(...PLAN_VERSION_NEWEST_FIRST);

  /*
   * One grouped count rather than a count per row: the history is short today
   * and `subscription` is not, so the query that scales with the platform is
   * the one worth doing once.
   */
  const counts =
    versions.length === 0
      ? []
      : await database
          .select({
            planVersionId: schema.subscription.planVersionId,
            count: sql<number>`count(*)::int`,
          })
          .from(schema.subscription)
          .where(
            inArray(
              schema.subscription.planVersionId,
              versions.map((version) => version.id),
            ),
          )
          .groupBy(schema.subscription.planVersionId);

  const countById = new Map(counts.map((row) => [row.planVersionId, row.count]));

  const seenLive = new Set<PlanTierId>();
  const history = versions.map((version) => {
    const row = toRow(version, countById.get(version.id) ?? 0);
    if (!seenLive.has(row.planId)) {
      seenLive.add(row.planId);
      row.isLive = true;
    }
    return row;
  });

  const tiers: PlanTierView[] = PLAN_TIER_IDS.map((id) => ({
    id,
    live: history.find((row) => row.planId === id && row.isLive) ?? null,
  }));

  return { tiers, history };
}

interface Actor {
  administratorId: string;
  email: string;
  clientAddress?: string | null;
}

export interface CreatePlanVersionInput extends PlanVersionInput {
  actor: Actor;
  reason: string;
  /**
   * The id of the version the form was built from, or null for "this tier had
   * none". Compared against the live row before anything is written.
   *
   * Without it the screen is a lost update waiting to happen: an operator with
   * a dialog open while someone else mints a version would submit the values
   * they were prefilled with, see them differ from the *new* live row, and
   * supersede a change they were never shown. It also makes a replayed submit
   * idempotent -- the retry still carries the id it read, which has moved.
   */
  expectedLiveVersionId: string | null;
}

export interface CreatePlanVersionResult {
  planVersionId: string;
  /** The row this one supersedes, and what it is still billing. */
  supersededId: string | null;
  supersededSubscriptions: number;
}

/**
 * Mints a version and records it.
 *
 * Nothing about existing subscriptions changes here, and that is the point:
 * requirement.md 4.3 says a plan change reaches new subscriptions and
 * explicitly migrated ones only, and never rewrites historical usage. Migrating
 * a workspace onto a new version is a separate, per-subscription decision; this
 * use case must not be the thing that quietly re-prices anyone.
 */
export async function createPlanVersion(
  input: CreatePlanVersionInput,
): Promise<CreatePlanVersionResult> {
  const reason = normalizeReason(input.reason);
  const draft = parsePlanVersionDraft(input);

  const live = await currentPlanVersion(draft.planId);
  /*
   * The showcase entitlements (lib/domain/showcase.ts) have no field on the
   * console form: a version carries them over from the one it supersedes,
   * so an override set on the live row survives a price edit instead of
   * silently falling back to the tier default.
   */
  if (live && tierHasEntitlements(draft.planId)) {
    draft.capabilities = capabilitiesFor({
      showcasePages: live.capabilities.showcasePages,
      showcaseBranding: live.capabilities.showcaseBranding,
      showcaseLeadsRetained: live.capabilities.showcaseLeadsRetained,
      showcaseCustomDomain: live.capabilities.showcaseCustomDomain,
    });
  }
  /*
   * Checked before `no_change`, because the two answer different questions and
   * the operator needs the one about the world moving under them. A stale form
   * whose values happen to match the *old* live row would otherwise be refused
   * as a no-op, which reads as "nothing to do" when the truth is "reload".
   */
  if ((live?.id ?? null) !== input.expectedLiveVersionId) {
    throw new PlanChangeRefused(
      'superseded',
      'the live version changed after this form was opened',
    );
  }
  if (isSamePlanVersion(draft, live)) {
    throw new PlanChangeRefused('no_change', 'that is what the live version already says');
  }

  const planVersionId = uuidv7();
  const database = db();

  await database.transaction(async (tx) => {
    /*
     * The tier row has to exist for the foreign key, and a deployment that
     * skipped the seed migration would otherwise fail with a constraint error
     * an operator cannot act on. Inserting it is safe: `plan` holds an id and a
     * display name, nothing versioned.
     */
    await tx
      .insert(schema.plan)
      .values({ id: draft.planId, name: draft.planId })
      .onConflictDoNothing();
    await tx.insert(schema.planVersion).values({
      id: planVersionId,
      planId: draft.planId,
      priceMinor: draft.priceMinor,
      currency: draft.currency,
      monthlyCalls: draft.monthlyCalls,
      apiKeyLimit: draft.apiKeyLimit,
      buildBaseCalls: draft.buildBaseCalls,
      buildTokensPerCall: draft.buildTokensPerCall,
      buildPagesPerCall: draft.buildPagesPerCall,
      capabilities: { ...draft.capabilities },
    });
  });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'plan.create_version',
    targetType: 'plan_version',
    targetId: planVersionId,
    reason,
    beforeValue: live ? auditShape(live) : null,
    afterValue: { planVersionId, ...auditShape({ ...draft, id: planVersionId }) },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return {
    planVersionId,
    supersededId: live?.id ?? null,
    supersededSubscriptions: live?.subscriptions ?? 0,
  };
}

/** What the audit log keeps of a version: every field that decides money or ceilings. */
function auditShape(version: {
  id?: string;
  planId: PlanTierId;
  priceMinor: number;
  currency: string;
  monthlyCalls: number;
  apiKeyLimit: number;
  buildBaseCalls: number;
  buildTokensPerCall: number;
  buildPagesPerCall: number;
  capabilities: PlanCapabilities;
}): Record<string, unknown> {
  return {
    planVersionId: version.id,
    planId: version.planId,
    priceMinor: version.priceMinor,
    currency: version.currency,
    monthlyCalls: version.monthlyCalls,
    apiKeyLimit: version.apiKeyLimit,
    buildBaseCalls: version.buildBaseCalls,
    buildTokensPerCall: version.buildTokensPerCall,
    buildPagesPerCall: version.buildPagesPerCall,
    capabilities: version.capabilities,
  };
}
