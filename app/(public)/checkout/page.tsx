import type { Metadata } from 'next';
import { PaddleCheckout } from '@/components/site/paddle-checkout';
import { paddleConfig } from '@/lib/infrastructure/payment/paddle';
import { currentLocale, getMessages } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { checkout } = await getMessages();
  /* A page per transaction id; nothing here is worth indexing. */
  return { title: checkout.metaTitle, robots: { index: false, follow: false } };
}

/**
 * Paddle's default payment link. Set it to `${APP_BASE_URL}/checkout` in the
 * Paddle dashboard (Checkout settings), on an approved domain; every checkout
 * this deployment creates also names it explicitly.
 *
 * The client token is read here rather than baked in as a NEXT_PUBLIC_
 * variable, so a self-hosted image picks it up from its runtime environment
 * like every other setting instead of needing a rebuild.
 */
export default async function CheckoutPage() {
  const [{ checkout: c }, locale] = await Promise.all([getMessages(), currentLocale()]);
  const config = paddleConfig();

  if (!config) {
    return (
      <section className="mx-auto flex w-full max-w-[520px] flex-1 items-center justify-center px-5 py-20 text-center">
        <p className="text-[14px] leading-[1.7] text-steel">{c.notConnected}</p>
      </section>
    );
  }

  return (
    <PaddleCheckout
      token={config.clientToken}
      environment={config.environment}
      locale={locale === 'zh' ? 'zh-Hans' : 'en'}
      labels={{
        opening: c.opening,
        closed: c.closed,
        completed: c.completed,
        missing: c.missing,
        failed: c.failed,
        reopen: c.reopen,
        back: c.back,
      }}
    />
  );
}
