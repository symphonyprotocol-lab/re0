import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { PaddleError, PaddleNotConfigured } from '@/lib/infra/paddle';
import { checkoutState, startCheckout } from '@/lib/services/billing';

/**
 * `POST /api/billing/checkout` `{kind: 'plan'|'pack', quantity, consent, earnedMinor?}`:
 * the Paddle transaction the checkout page's overlay opens, with
 * `earnedMinor` US cents paid by earned credits; when they pay it all, the
 * purchase itself (`purchaseId`) and no transaction. A Pack needs an
 * active Plan and a quantity of 1–10; anything else is refused before Paddle
 * hears of it.
 */
export async function POST(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  try {
    const result = await startCheckout(user.id, await body(request));
    if (!result.ok) return fail(result.error, ['plan_required', 'already_subscribed', 'renewal_pending', 'plan_redeemed_active', 'price_changed', 'insufficient_earned'].includes(result.error) ? 409 : 400);
    /* Paid in full with earned credits: no Paddle transaction, the purchase is already made. */
    if (result.purchaseId) return json({ purchaseId: result.purchaseId, kind: result.order.kind, quantity: result.order.quantity, earnedMinor: result.earnedMinor });
    return json({ transactionId: result.transactionId, kind: result.order.kind, quantity: result.order.quantity, earnedMinor: result.earnedMinor });
  } catch (error) {
    if (error instanceof PaddleNotConfigured) return fail('payments_unavailable', 503);
    if (error instanceof PaddleError) {
      console.error('checkout failed', error.message);
      return fail('payment_provider', 502);
    }
    throw error;
  }
}

/** `GET /api/billing/checkout?transaction=txn_…`: whether that payment has reached this user's balance. */
export async function GET(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const transaction = request.nextUrl.searchParams.get('transaction') ?? '';
  if (!/^txn_[a-z0-9]{10,64}$/.test(transaction)) return fail('invalid_transaction', 400);
  return json(await checkoutState(user.id, transaction));
}
