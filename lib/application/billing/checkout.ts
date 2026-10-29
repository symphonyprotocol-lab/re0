/**
 * Use cases: start a purchase, and open the provider's billing portal.
 *
 * Neither takes money. A checkout asks the provider for a transaction priced
 * at the Plan Version being bought and hands back the link that opens it; what
 * the buyer ends up with is decided later, by the webhook, from what the
 * provider says was paid (./webhook). That ordering is architecture.md 11.3's
 * fail-closed rule from the other side: nothing here grants anything, so a
 * checkout that never completes leaves nothing to undo.
 *
 * The only thing sold is the Additional Calls pack, and anyone who
 * administers a workspace may buy one (agent-first-proposal.md 8.1). Every
 * click is a pack: two clicks are two packs, which is what the buyer asked
 * for, so there is nothing to de-duplicate the way a subscription had to be.
 */
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@/lib/domain/id';
import { paymentAdapter, type PaymentAdapter } from '@/lib/infrastructure/payment/provider';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { PLAN_VERSION_NEWEST_FIRST } from '@/lib/application/plans/configuration';
import { workspaceProviderCustomer } from './webhook';

export const CHECKOUT_REFUSALS = ['not_connected', 'forbidden', 'no_plan', 'no_customer'] as const;

export type CheckoutRefusal = (typeof CHECKOUT_REFUSALS)[number];

export function isCheckoutRefusal(value: unknown): value is CheckoutRefusal {
  return typeof value === 'string' && (CHECKOUT_REFUSALS as readonly string[]).includes(value);
}

export class CheckoutRefused extends Error {
  constructor(readonly code: CheckoutRefusal) {
    super(`checkout refused: ${code}`);
    this.name = 'CheckoutRefused';
  }
}

/**
 * Billing is the workspace's money, so only the roles that administer the
 * workspace may spend it or change how it is paid. A developer key-holder
 * buying packs on the owner's card is not a scenario to allow.
 */
export const BILLING_ROLES = new Set(['owner', 'admin']);

interface Caller {
  workspaceId: string;
  role: string;
}

function adapterFor(caller: Caller): PaymentAdapter {
  if (!BILLING_ROLES.has(caller.role)) throw new CheckoutRefused('forbidden');
  try {
    return paymentAdapter();
  } catch {
    throw new CheckoutRefused('not_connected');
  }
}

/** Returns the URL that opens the provider's checkout for one Additional Calls pack. */
export async function startCheckout(caller: Caller): Promise<string> {
  const adapter = adapterFor(caller);

  const [version] = await db()
    .select({
      id: schema.planVersion.id,
      priceMinor: schema.planVersion.priceMinor,
      currency: schema.planVersion.currency,
      name: schema.plan.name,
    })
    .from(schema.planVersion)
    .innerJoin(schema.plan, eq(schema.plan.id, schema.planVersion.planId))
    .where(eq(schema.planVersion.planId, 'addon'))
    .orderBy(...PLAN_VERSION_NEWEST_FIRST)
    .limit(1);
  /* A zero-priced pack is a catalogue mistake, not a free gift to hand out. */
  if (!version || version.priceMinor <= 0) throw new CheckoutRefused('no_plan');

  const order = {
    kind: 'pack' as const,
    workspaceId: caller.workspaceId,
    planVersionId: version.id,
    priceMinor: version.priceMinor,
    currency: version.currency,
    name: `Re0 ${version.name}`,
    customerId: await workspaceProviderCustomer(caller.workspaceId),
  };

  return db().transaction(async (tx) => {
    /*
     * One checkout decision per workspace at a time, so the provider call and
     * the row that records it cannot interleave with another click's.
     */
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`checkout:${caller.workspaceId}`}))`);
    const created = await adapter.createCheckout(order);
    await tx.insert(schema.paymentCheckout).values({
      id: uuidv7(),
      workspaceId: caller.workspaceId,
      provider: adapter.provider,
      externalId: created.externalId,
      kind: 'pack',
      planVersionId: version.id,
      checkoutUrl: created.url,
    });
    return created.url;
  });
}

/** Returns a signed link into the provider's portal for this workspace's customer. */
export async function billingPortalUrl(caller: Caller): Promise<string> {
  const adapter = adapterFor(caller);
  const customerId = await workspaceProviderCustomer(caller.workspaceId);
  if (!customerId) throw new CheckoutRefused('no_customer');
  return adapter.portalUrl({ customerId });
}
