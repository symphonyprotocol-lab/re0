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
 * The refusals are the product rules that have to hold *before* the provider
 * is asked, because afterwards they would be a refund: one subscription per
 * workspace, and packs for Pro only (requirement.md 4.1).
 */
import { and, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import type { BillingDocumentKind } from '@/lib/domain/billing';
import { uuidv7 } from '@/lib/domain/id';
import type { PlanTierId } from '@/lib/domain/plans';
import { paymentAdapter, type PaymentAdapter } from '@/lib/infrastructure/payment/provider';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { PLAN_VERSION_NEWEST_FIRST } from '@/lib/application/plans/configuration';
import { hasPaidSubscription, type Tx } from '@/lib/application/plans/quota';
import { LIVE_PROVIDER_STATUSES, workspaceProviderCustomer } from './webhook';

export const CHECKOUT_REFUSALS = [
  'not_connected',
  'forbidden',
  'already_subscribed',
  /** A subscription checkout was paid and its webhook has not landed yet. */
  'pending',
  'pro_required',
  'no_plan',
  'no_customer',
] as const;

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
 * buying a subscription on the owner's card is not a scenario to allow.
 */
const BILLING_ROLES = new Set(['owner', 'admin']);

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

/**
 * How far back an unconfirmed subscription checkout is still asked about. A
 * paid checkout is confirmed by its webhook within seconds; a day covers the
 * provider's retry schedule for a webhook that is not, without asking the
 * provider about every checkout a workspace ever opened.
 */
const CHECKOUT_LOOKBACK = sql`interval '24 hours'`;

/** Returns the URL that opens the provider's checkout for this purchase. */
export async function startCheckout(
  caller: Caller & { kind: BillingDocumentKind },
): Promise<string> {
  const adapter = adapterFor(caller);

  if (caller.kind === 'pack' && !(await hasPaidSubscription(caller.workspaceId))) {
    throw new CheckoutRefused('pro_required');
  }

  const tier: PlanTierId = caller.kind === 'subscription' ? 'pro' : 'addon';
  const [version] = await db()
    .select({
      id: schema.planVersion.id,
      priceMinor: schema.planVersion.priceMinor,
      currency: schema.planVersion.currency,
      name: schema.plan.name,
    })
    .from(schema.planVersion)
    .innerJoin(schema.plan, eq(schema.plan.id, schema.planVersion.planId))
    .where(eq(schema.planVersion.planId, tier))
    .orderBy(...PLAN_VERSION_NEWEST_FIRST)
    .limit(1);
  /* A zero-priced paid tier is a catalogue mistake, not a free gift to hand out. */
  if (!version || version.priceMinor <= 0) throw new CheckoutRefused('no_plan');

  const order = {
    kind: caller.kind,
    workspaceId: caller.workspaceId,
    planVersionId: version.id,
    priceMinor: version.priceMinor,
    currency: version.currency,
    name: `Re0 ${version.name}`,
    customerId: await workspaceProviderCustomer(caller.workspaceId),
  };

  return db().transaction(async (tx) => {
    /*
     * One checkout decision per workspace at a time: two clicks racing each
     * other would otherwise both find nothing open and both create one. The
     * provider calls below run under the lock, which is the point -- the
     * decision is not made until they answer.
     */
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`checkout:${caller.workspaceId}`}))`);

    if (caller.kind === 'subscription') {
      if (await hasLiveProviderSubscription(tx, caller.workspaceId)) {
        throw new CheckoutRefused('already_subscribed');
      }

      /*
       * The window `subscription` cannot see: a checkout already paid whose
       * webhook has not landed. The buyer is looking at "payment complete"
       * beside a plan card that still offers the upgrade, and a second click
       * there must not open a second subscription. A checkout still open is
       * handed back instead of a new one, so two tabs share one payable order.
       */
      const recent = await tx
        .select({
          externalId: schema.paymentCheckout.externalId,
          planVersionId: schema.paymentCheckout.planVersionId,
          checkoutUrl: schema.paymentCheckout.checkoutUrl,
        })
        .from(schema.paymentCheckout)
        .where(
          and(
            eq(schema.paymentCheckout.workspaceId, caller.workspaceId),
            eq(schema.paymentCheckout.provider, adapter.provider),
            eq(schema.paymentCheckout.kind, 'subscription'),
            gt(schema.paymentCheckout.createdAt, sql`now() - ${CHECKOUT_LOOKBACK}`),
          ),
        )
        .orderBy(desc(schema.paymentCheckout.createdAt))
        .limit(5);

      let reusable: string | null = null;
      for (const checkout of recent) {
        const state = await adapter.checkoutState(checkout.externalId);
        if (state === 'paid') throw new CheckoutRefused('pending');
        /* Only at today's price: a version minted since supersedes the open order. */
        if (state === 'open' && reusable === null && checkout.planVersionId === version.id) {
          reusable = checkout.checkoutUrl;
        }
      }
      if (reusable) return reusable;
    }

    const created = await adapter.createCheckout(order);
    await tx.insert(schema.paymentCheckout).values({
      id: uuidv7(),
      workspaceId: caller.workspaceId,
      provider: adapter.provider,
      externalId: created.externalId,
      kind: caller.kind,
      planVersionId: version.id,
      checkoutUrl: created.url,
    });
    return created.url;
  });
}

/**
 * Whether the workspace already has a provider subscription that is not over.
 *
 * Wider than "on a paid plan": a subscription whose renewal failed is
 * `past_due`, and a paused one is `paused`; neither grants anything, but both
 * are still billing -- a second checkout would leave two subscriptions
 * charging one card once the first is fixed or resumed. Their holder belongs
 * in the portal.
 */
async function hasLiveProviderSubscription(tx: Tx, workspaceId: string): Promise<boolean> {
  const [live] = await tx
    .select({ id: schema.subscription.id })
    .from(schema.subscription)
    .where(
      and(
        eq(schema.subscription.workspaceId, workspaceId),
        isNotNull(schema.subscription.providerSubscriptionId),
        inArray(schema.subscription.status, [...LIVE_PROVIDER_STATUSES]),
      ),
    )
    .limit(1);
  return live !== undefined;
}

/** Returns a signed link into the provider's portal for this workspace's customer. */
export async function billingPortalUrl(caller: Caller): Promise<string> {
  const adapter = adapterFor(caller);
  const customerId = await workspaceProviderCustomer(caller.workspaceId);
  if (!customerId) throw new CheckoutRefused('no_customer');
  return adapter.portalUrl({ customerId });
}
