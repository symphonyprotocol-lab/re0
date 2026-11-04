import { and, eq, isNull, sql } from 'drizzle-orm';
import { defaultPrice, parsePriceSettings, priceView, type PricingView, type PriceView } from '@/lib/domain/pricing';
import type { PurchaseKind } from '@/lib/domain/billing';
import { db, schema, type Executor } from '@/lib/infra/db';
import { paddleConfig, provisionPrice, requirePaddle, type PaddleConfig } from '@/lib/infra/paddle';
import { AdminInputError, audit } from '@/lib/services/admin';

export function pricingEnvironment(): 'sandbox' | 'production' {
  return process.env.PADDLE_ENVIRONMENT?.trim() === 'sandbox' ? 'sandbox' : 'production';
}

type Row = typeof schema.billingPrice.$inferSelect;
function view(row: Row, now: Date): PriceView {
  return priceView(
    {
      priceMinor: row.priceMinor,
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

export async function checkoutPrice(executor: Executor, config: PaddleConfig, kind: PurchaseKind, now: Date) {
  const row = (await pricingRows(executor, config.environment)).find((r) => r.kind === kind);
  const price = row ? view(row, now) : defaultPrice(kind, now);
  return {
    ...price,
    priceId: row?.paddlePriceId ?? (kind === 'plan' ? config.planPriceId : config.packPriceId),
    regularPriceMinor: price.priceMinor,
    priceMinor: price.effectivePriceMinor,
  };
}

export async function savePricing(
  administratorId: string,
  kind: PurchaseKind,
  raw: Record<string, unknown>,
  deps: { config?: PaddleConfig; provision?: typeof provisionPrice; now?: Date } = {},
): Promise<PriceView> {
  const input = parsePriceSettings(raw);
  if (
    !input ||
    typeof raw.revision !== 'string' ||
    (input.promotion && Date.parse(input.promotion.endsAt) <= (deps.now ?? new Date()).getTime())
  )
    throw new AdminInputError('invalid_pricing');
  const config = deps.config ?? requirePaddle();
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`pricing:${config.environment}:${kind}`}))`);
    const previous = (await pricingRows(tx, config.environment)).find((r) => r.kind === kind);
    if (raw.revision !== (previous?.id ?? 'default')) throw new AdminInputError('pricing_conflict');
    const sourceId = previous?.paddlePriceId ?? (kind === 'plan' ? config.planPriceId : config.packPriceId);
    const paddlePriceId = await (deps.provision ?? provisionPrice)(config, kind, input.priceMinor, sourceId);
    // Retain the environment's original catalogue ID even after its first replacement.
    if (!previous)
      await tx.insert(schema.billingPrice).values({
        environment: config.environment,
        kind,
        priceMinor: defaultPrice(kind).priceMinor,
        paddlePriceId: sourceId,
        enabled: false,
      });
    await tx
      .update(schema.billingPrice)
      .set({ enabled: false })
      .where(and(eq(schema.billingPrice.environment, config.environment), eq(schema.billingPrice.kind, kind)));
    const [row] = await tx
      .insert(schema.billingPrice)
      .values({
        environment: config.environment,
        kind,
        priceMinor: input.priceMinor,
        paddlePriceId,
        promotionPriceMinor: input.promotion?.priceMinor ?? null,
        promotionStartsAt: input.promotion ? new Date(input.promotion.startsAt) : null,
        promotionEndsAt: input.promotion ? new Date(input.promotion.endsAt) : null,
        updatedBy: administratorId,
      })
      .returning();
    const next = view(row!, deps.now ?? new Date());
    await audit(tx, {
      administratorId,
      action: 'pricing.update',
      target: kind,
      before: previous ? view(previous, new Date()) : defaultPrice(kind),
      after: next,
    });
    return next;
  });
}

export function paymentsConfigured() {
  return Boolean(paddleConfig());
}

/** A payment link displays the price originally quoted, visible only to its buyer. */
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
  if (!order || order.unitPriceMinor === null) return null;
  const revision = order.priceKey?.split(':')[0];
  const [historical] =
    revision && revision !== 'default'
      ? await db().select().from(schema.billingPrice).where(eq(schema.billingPrice.id, revision)).limit(1)
      : [];
  const price = historical
    ? view(historical, order.createdAt)
    : priceView({ priceMinor: order.unitPriceMinor, promotion: null }, 'default', order.createdAt);
  return { kind: order.kind, quantity: order.quantity, price: { ...price, effectivePriceMinor: order.unitPriceMinor } };
}
