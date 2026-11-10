/**
 * `/checkout?_ptxn=` (Paddle's payment link). Paddle.js opens the checkout
 * for any `_ptxn` on a page where it is initialized, before our code runs,
 * so the page decides on the server whether the transaction is the
 * viewer's own (review C12): it stays only then; a visitor signs in first,
 * and anyone else's transaction is dropped from the address.
 */
export type PaymentLinkAccess = 'open' | 'sign_in' | 'drop';

export function paymentLinkAccess(input: { signedIn: boolean; owned: boolean }): PaymentLinkAccess {
  if (!input.signedIn) return 'sign_in';
  return input.owned ? 'open' : 'drop';
}

/**
 * Whether a Paddle transaction is this user's when we hold no checkout row
 * for it -- a payment-method update or a renewal retry Paddle links to from
 * its own emails: it carries the user's id in `custom_data`, or it belongs
 * to one of the user's subscriptions.
 */
export function transactionBelongsTo(
  transaction: { custom_data: Record<string, unknown> | null; subscription_id: string | null },
  userId: string,
  subscriptionIds: readonly string[],
  customUserId: (custom: Record<string, unknown> | null | undefined) => string | null,
): boolean {
  if (customUserId(transaction.custom_data) === userId) return true;
  return Boolean(transaction.subscription_id && subscriptionIds.includes(transaction.subscription_id));
}
