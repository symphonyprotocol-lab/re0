import { and, eq, isNull, sql } from 'drizzle-orm';
import { defaultPrice, parsePriceSettings, priceView, type PricingView, type PriceView } from '@/lib/domain/pricing';
import type { PurchaseKind } from '@/lib/domain/billing';
import { db, schema, type Executor } from '@/lib/infra/db';
import { transactionBelongsTo } from '@/lib/domain/payment-link';
import {
  archivePrice,
  customUserId,
  describeBadPriceId,
  getTransaction,
  isPaddlePriceId,
  paddleConfig,
  PaddleError,
  provisionPrice,
  requirePaddle,
  verifyPrice,
  type PaddleConfig,
} from '@/lib/infra/paddle';
import { AdminInputError, audit } from '@/lib/services/admin';

export function pricingEnvironment(): 'sandbox' | 'production' {
  return process.env.PADDLE_ENVIRONMENT?.trim() === 'sandbox' ? 'sandbox' : 'production';
}

type Row = typeof schema.billingPrice.$inferSelect;
function view(row: Row, now: Date): PriceView {
  return priceView(
    {
      priceMinor: row.priceMinor,
      credits: row.credits ?? defaultPrice(row.kind, now).credits,
      promotion:
        row.promotionPriceMinor !== null
          ? {
              priceMinor: row.promotionPriceMinor,
              startsAt: row.promotionStartsAt!.toISOString(),
              endsAt: row.promotionEndsAt!.toISOString(),
            }
          : null,
    },
    row.id,
    now,
  );
}

export async function pricingRows(executor: Executor = db(), environment = pricingEnvironment()) {
  return executor
    .select()
    .from(schema.billingPrice)
    .where(and(eq(schema.billingPrice.environment, environment), eq(schema.billingPrice.enabled, true)));
}

/** No process cache: time boundaries and admin changes take effect on the next request. */
export async function currentPricing(now = new Date()): Promise<PricingView> {
  const rows = await pricingRows();
  const result = { plan: defaultPrice('plan', now), pack: defaultPrice('pack', now) };
  for (const row of rows) result[row.kind] = view(row, now);
  return result;
}

/**
 * The Paddle price a catalogue row charges. A row holding something that is
 * not a price ID (saved while the environment's was wrong) would fail every
 * checkout, so the environment's price is used instead and the row logged.
 */
function cataloguePriceId(row: Row | undefined, config: PaddleConfig, kind: PurchaseKind): string {
  const fallback = kind === 'plan' ? config.planPriceId : config.packPriceId;
  if (!row || isPaddlePriceId(row.paddlePriceId)) return row?.paddlePriceId ?? fallback;
  console.error(
    `pricing: billing_price ${row.id} (${row.environment} ${row.kind}) holds an invalid Paddle price ID (${describeBadPriceId(row.paddlePriceId)}); using ${kind === 'plan' ? 'PADDLE_PLAN_PRICE_ID' : 'PADDLE_PACK_PRICE_ID'} instead. Re-save ${kind} pricing to replace it.`,
  );
  return fallback;
}

export async function checkoutPrice(executor: Executor, config: PaddleConfig, kind: PurchaseKind, now: Date) {
  const row = (await pricingRows(executor, config.environment)).find((r) => r.kind === kind);
  const price = row ? view(row, now) : defaultPrice(kind, now);
  return {
    ...price,
    priceId: cataloguePriceId(row, config, kind),
    regularPriceMinor: price.priceMinor,
    priceMinor: price.effectivePriceMinor,
  };
}

export async function currentUnitCredits(executor: Executor, kind: PurchaseKind, environment = pricingEnvironment()) {
  const row = (await pricingRows(executor, environment)).find((r) => r.kind === kind);
  return row?.credits ?? defaultPrice(kind).credits;
}

export async function savePricing(
  administratorId: string,
  kind: PurchaseKind,
  raw: Record<string, unknown>,
  deps: { config?: PaddleConfig; provision?: typeof provisionPrice; verify?: typeof verifyPrice; archive?: typeof archivePrice; now?: Date } = {},
): Promise<PriceView> {
  const input = parsePriceSettings(raw);
  if (!input || typeof raw.revision !== 'string') throw new AdminInputError('invalid_pricing');
  const config = deps.config ?? requirePaddle();
  /* A price created in Paddle whose catalogue row then fails to commit is archived there again. */
  let provisioned = null as string | null;
  try {
    return await savePricingInTx(administratorId, kind, raw, input, config, deps, (id) => { provisioned = id; });
  } catch (error) {
    if (provisioned) {
      const orphan = provisioned;
      await (deps.archive ?? archivePrice)(config, orphan).catch(() => console.warn(`paddle price ${orphan} is unused after a failed save; archive it in Paddle`));
    }
    throw error;
  }
}

function savePricingInTx(
  administratorId: string,
  kind: PurchaseKind,
  raw: Record<string, unknown>,
  input: NonNullable<ReturnType<typeof parsePriceSettings>>,
  config: PaddleConfig,
  deps: { provision?: typeof provisionPrice; verify?: typeof verifyPrice; now?: Date },
  created: (paddlePriceId: string) => void,
): Promise<PriceView> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`pricing:${config.environment}:${kind}`}))`);
    const previous = (await pricingRows(tx, config.environment)).find((r) => r.kind === kind);
    if (raw.revision !== (previous?.id ?? 'default')) throw new AdminInputError('pricing_conflict');
    const now = deps.now ?? new Date();
    const before = previous ? view(previous, now) : defaultPrice(kind, now);
    if (input.promotion && Date.parse(input.promotion.endsAt) <= now.getTime() &&
      (input.promotion.priceMinor !== before.promotion?.priceMinor ||
        input.promotion.startsAt !== before.promotion.startsAt || input.promotion.endsAt !== before.promotion.endsAt))
      throw new AdminInputError('invalid_pricing');
    const sourceId = cataloguePriceId(previous, config, kind);
    let paddlePriceId: string;
    if (input.priceMinor === before.priceMinor) {
      // A price kept as it is is checked with Paddle first: once in an enabled row, it overrides the environment.
      const problem = await (deps.verify ?? verifyPrice)(config, kind, sourceId);
      if (problem !== null) {
        const origin = previous?.paddlePriceId === sourceId ? `billing_price ${previous.id}` : kind === 'plan' ? 'PADDLE_PLAN_PRICE_ID' : 'PADDLE_PACK_PRICE_ID';
        console.error(`pricing: the ${kind} Paddle price from ${origin} cannot be kept: ${problem}`);
        throw new AdminInputError('invalid_paddle_price');
      }
      paddlePriceId = sourceId;
    } else {
      paddlePriceId = await (deps.provision ?? provisionPrice)(config, kind, input.priceMinor, sourceId);
    }
    if (paddlePriceId !== sourceId) created(paddlePriceId);
    if (!isPaddlePriceId(paddlePriceId)) throw new PaddleError(`paddle returned an invalid price ID (${describeBadPriceId(paddlePriceId)})`);
    // Retain the environment's original catalogue ID even after its first replacement.
    if (!previous && paddlePriceId !== sourceId)
      await tx.insert(schema.billingPrice).values({
        environment: config.environment,
        kind,
        priceMinor: before.priceMinor,
        credits: before.credits,
        paddlePriceId: sourceId,
        enabled: false,
      });
    if (previous) await tx.update(schema.billingPrice).set({ enabled: false }).where(eq(schema.billingPrice.id, previous.id));
    const [row] = await tx
      .insert(schema.billingPrice)
      .values({
        environment: config.environment,
        kind,
        priceMinor: input.priceMinor,
        credits: input.credits ?? before.credits,
        paddlePriceId,
        promotionPriceMinor: input.promotion?.priceMinor ?? null,
        promotionStartsAt: input.promotion ? new Date(input.promotion.startsAt) : null,
        promotionEndsAt: input.promotion ? new Date(input.promotion.endsAt) : null,
        updatedBy: administratorId,
      })
      .returning();
    const next = view(row!, now);
    await audit(tx, {
      administratorId,
      action: 'pricing.update',
      target: kind,
      before,
      after: next,
    });
    return next;
  });
}

export function paymentsConfigured() {
  return Boolean(paddleConfig());
}

/** A payment link displays the original price and credits, visible only to its buyer. */
/**
 * Whether a payment link's transaction we hold no checkout row for is still
 * this user's (a Paddle email's payment-method update): asked of Paddle,
 * checked against the user's id and subscriptions. Any doubt -- no Paddle,
 * an API error -- answers false, so the link is dropped rather than opened.
 */
export async function ownsPaddleTransaction(userId: string, transactionId: string, fetchTransaction = getTransaction): Promise<boolean> {
  const config = paddleConfig();
  if (!config) return false;
  /* One of our own checkouts that is not this user's live one (someone else's, or superseded): never opened. */
  const [checkout] = await db().select({ id: schema.paddleCheckout.paddleTransactionId }).from(schema.paddleCheckout).where(eq(schema.paddleCheckout.paddleTransactionId, transactionId)).limit(1);
  if (checkout) return false;
  try {
    const [transaction, subscriptions] = await Promise.all([
      fetchTransaction(config, transactionId),
      db().select({ id: schema.subscription.paddleSubscriptionId }).from(schema.subscription).where(eq(schema.subscription.userId, userId)),
    ]);
    return transactionBelongsTo(transaction, userId, subscriptions.map((row) => row.id), customUserId);
  } catch (error) {
    console.warn(`checkout: payment link ${transactionId} not checked: ${error instanceof Error ? error.message : 'unknown'}`);
    return false;
  }
}

export async function pendingCheckoutPricing(userId: string, transactionId: string) {
  const [order] = await db()
    .select()
    .from(schema.paddleCheckout)
    .where(
      and(
        eq(schema.paddleCheckout.userId, userId),
        eq(schema.paddleCheckout.paddleTransactionId, transactionId),
        isNull(schema.paddleCheckout.supersededAt),
      ),
    )
    .limit(1);
  if (!order) return null;
  const revision = order.priceKey?.split(':')[0];
  const [historical] =
    revision && revision !== 'default'
      ? await db().select().from(schema.billingPrice).where(eq(schema.billingPrice.id, revision)).limit(1)
      : [];
  const price = historical
    ? view(historical, order.createdAt)
    : priceView({ priceMinor: order.unitPriceMinor ?? defaultPrice(order.kind).priceMinor, credits: order.unitCredits, promotion: null }, 'default', order.createdAt);
  return {
    kind: order.kind,
    quantity: order.quantity,
    price: { ...price, credits: order.unitCredits, effectivePriceMinor: order.unitPriceMinor ?? price.effectivePriceMinor },
  };
}
