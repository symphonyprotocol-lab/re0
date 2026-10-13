/**
 * External subscription provider. re0 never stores card data.
 *
 * The adapter is the only module that knows a provider's vocabulary. What
 * crosses this boundary is ours: a checkout is asked for in terms of a Plan
 * Version, and a webhook comes back as a notice about a subscription or a
 * billing document in the shapes the mirror already accepts
 * (lib/domain/billing). Everything after that -- which workspace, which
 * version, whether the state is newer than what we hold -- is decided by
 * lib/application/billing, against the database, where the provider cannot
 * reach.
 *
 * Paddle is the provider (architecture.md 11.3). It is configured from the
 * environment rather than the console because its webhook secret is what
 * proves a notification came from Paddle, and a secret an operator could
 * change from a browser session is a secret a stolen session could change.
 */
import { paddleAdapter, paddleConfig } from './paddle';
import { PaymentNotConfigured, type PaymentAdapter } from './types';

export * from './types';

/**
 * The configured adapter. Throws when no provider is configured, which
 * `isPaymentConnected` reads as "not connected" rather than as an error.
 */
export function paymentAdapter(): PaymentAdapter {
  const config = paddleConfig();
  if (!config) throw new PaymentNotConfigured();
  return paddleAdapter(config);
}
