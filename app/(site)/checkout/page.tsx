import { currentPricing, pendingCheckoutPricing } from '@/lib/services/pricing';
import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { pageQuantity } from '@/lib/domain/billing';
import { currentUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { paddleConfig } from '@/lib/infra/paddle';
import { hasActivePlan } from '@/lib/services/billing';
import { serverMessages } from '@/i18n/server';
import { Icon } from '@/components/ui/icons';
import { UserAvatar } from '@/components/ui/ree-avatar';
import { CheckoutPanel } from '@/components/site/checkout-panel';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.site.checkout.title };
}

/**
 * `/checkout?kind=plan|pack&quantity=` (prototype `#/checkout`). Open to
 * visitors; buying needs a session, and signing in returns here with the
 * same order. Paddle's own payment links land here too (`?_ptxn=`).
 */
export default async function CheckoutPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const query = await searchParams;
  const [user, { t }, prices] = await Promise.all([currentUser(), serverMessages(), currentPricing()]);
  const pending = typeof query._ptxn === 'string' && /^txn_[a-z0-9]{10,64}$/.test(query._ptxn) ? query._ptxn : null;
  const previous = user && pending ? await pendingCheckoutPricing(user.id, pending) : null;
  const kind = previous?.kind ?? (query.kind === 'pack' ? 'pack' : 'plan');
  const quantity = previous?.quantity ?? (kind === 'pack' ? pageQuantity(query.quantity) : 1);
  const c = t.site.checkout;
  const planActive = user ? await hasActivePlan(db(), user.id) : false;
  const config = paddleConfig();
  const self = kind === 'pack' ? `/checkout?kind=pack&quantity=${quantity}` : '/checkout?kind=plan';
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-10 sm:px-6 lg:py-14">
      <p className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted">
        <span className="text-ink">{c.step1}</span>
        <span aria-hidden="true">—</span>
        <span>{c.step2}</span>
      </p>
      <div className="mt-8 grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_420px]">
        <section className="min-w-0">
          <p className="eyebrow">{c.eyebrow}</p>
          <h1 className="mt-3 text-[32px] leading-tight font-extrabold sm:text-[42px]">
            {c.headline1}
            <br />
            {c.headline2}
          </h1>
          <div className="card mt-8 p-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[15px] font-bold">{c.account}</h2>
              <span className={`tag ${user ? 'border-[#cfe9df] bg-[#effaf5] text-green' : ''}`}>{user ? c.signedIn : c.signedOut}</span>
            </div>
            {user ? (
              <div className="mt-5 flex min-w-0 items-center gap-3">
                <UserAvatar avatar={user.avatarBlob} name={user.name} />
                <div className="min-w-0">
                  <strong className="block truncate text-[14px]">{user.name}</strong>
                  <p className="truncate text-[12px] text-muted">{user.email}</p>
                </div>
              </div>
            ) : (
              <>
                <p className="mt-3 text-[13px] text-muted">{c.signInBody}</p>
                <Link href={`/login?returnTo=${encodeURIComponent(pending ? `/checkout?_ptxn=${pending}` : self)}`} className="btn mt-5">
                  {c.signIn}
                  <Icon name="arrow" />
                </Link>
              </>
            )}
          </div>
          <p className="mt-5 flex items-start gap-2.5 rounded-xl border border-[#dfe6f5] bg-wash px-4 py-3 text-[12px] leading-relaxed text-muted">
            <Icon name="shield" className="mt-0.5 size-4 flex-none text-blue" />
            {c.paddleNote}
          </p>
        </section>
        <CheckoutPanel
          price={previous?.price ?? prices[kind]}
          kind={kind}
          quantity={quantity}
          signedIn={Boolean(user)}
          email={user?.email ?? null}
          planActive={planActive}
          paddle={config ? { clientToken: config.clientToken, environment: config.environment } : null}
          pendingTransaction={pending}
        />
      </div>
    </div>
  );
}
