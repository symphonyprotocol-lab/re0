/**
 * What a workspace's plan allows for showcase pages (lib/domain/plans.ts
 * `showcasePages`, `showcaseBranding`), read off the plan version in force
 * the way billing does: the subscription's version, else the newest Free one.
 */
import { and, count, eq, isNull } from 'drizzle-orm';
import { readCapabilities, type PlanTierId } from '@/lib/domain/plans';
import type { ShowcaseEntitlement } from '@/lib/domain/showcase';
import { PLAN_VERSION_NEWEST_FIRST } from '@/lib/application/plans/configuration';
import { IN_FORCE_FIRST, subscriptionInForce } from '@/lib/application/plans/in-force';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export interface WorkspaceShowcaseEntitlement extends ShowcaseEntitlement {
  /** On a paid tier right now: what decides the model audience and the draft cap. */
  paid: boolean;
  /** How many leads the owner is shown per page; -1 for every one. */
  leadsRetained: number;
  /** Whether a page may sit on the owner's own subdomain. */
  customDomain: boolean;
}

/**
 * How long a workspace's entitlement is kept once read. Public pages read it
 * on every view (a custom host, a lead); a plan changes rarely and a minute
 * of staleness on the visitor's side costs nothing, while the owner's own
 * screens ask for a fresh read.
 */
export const ENTITLEMENT_CACHE = { ttlMs: 60 * 1000, maxWorkspaces: 500 } as const;

const cache = new Map<string, { at: number; value: WorkspaceShowcaseEntitlement }>();

export async function showcaseEntitlement(
  workspaceId: string,
  options: { fresh?: boolean } = {},
): Promise<WorkspaceShowcaseEntitlement> {
  const cached = cache.get(workspaceId);
  if (!options.fresh && cached && Date.now() - cached.at < ENTITLEMENT_CACHE.ttlMs) return cached.value;
  const value = await readEntitlement(workspaceId);
  if (cache.size >= ENTITLEMENT_CACHE.maxWorkspaces) cache.clear();
  cache.set(workspaceId, { at: Date.now(), value });
  return value;
}

/** Test seam: the cache is module state. */
export function resetEntitlementCache(): void {
  cache.clear();
}

async function readEntitlement(workspaceId: string): Promise<WorkspaceShowcaseEntitlement> {
  const database = db();
  const [active] = await database
    .select({ planVersionId: schema.subscription.planVersionId })
    .from(schema.subscription)
    .where(and(eq(schema.subscription.workspaceId, workspaceId), subscriptionInForce()))
    .orderBy(...IN_FORCE_FIRST)
    .limit(1);

  const [version] = active
    ? await database
        .select({ planId: schema.planVersion.planId, capabilities: schema.planVersion.capabilities })
        .from(schema.planVersion)
        .where(eq(schema.planVersion.id, active.planVersionId))
        .limit(1)
    : await database
        .select({ planId: schema.planVersion.planId, capabilities: schema.planVersion.capabilities })
        .from(schema.planVersion)
        .where(eq(schema.planVersion.planId, 'free'))
        .orderBy(...PLAN_VERSION_NEWEST_FIRST)
        .limit(1);

  const tier = (version?.planId ?? 'free') as PlanTierId;
  const capabilities = readCapabilities(tier, version?.capabilities);
  return {
    pages: capabilities.showcasePages,
    brandingOptional: capabilities.showcaseBranding,
    paid: Boolean(active) && tier !== 'free',
    leadsRetained: capabilities.showcaseLeadsRetained,
    customDomain: capabilities.showcaseCustomDomain,
  };
}

type Database = ReturnType<typeof db>;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Pages the workspace has on live libraries; what the plan's cap counts. A deleted library's page is retired with it. */
export async function countWorkspaceShowcases(workspaceId: string, on: Database | Tx = db()): Promise<number> {
  const [row] = await on
    .select({ n: count() })
    .from(schema.libraryShowcase)
    .innerJoin(schema.library, eq(schema.library.id, schema.libraryShowcase.libraryId))
    .where(
      and(
        eq(schema.libraryShowcase.workspaceId, workspaceId),
        isNull(schema.libraryShowcase.deletedAt),
        isNull(schema.library.deletedAt),
      ),
    );
  return row?.n ?? 0;
}
