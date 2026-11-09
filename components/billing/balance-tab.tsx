import { currentPricing } from '@/lib/services/pricing';
import { ProductPrice, PromotionNotice } from '@/components/site/product-price';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { billingSummary } from '@/lib/services/billing';
import { serverMessages } from '@/i18n/server';
import { fill, formatDate, formatNumber, formatUsd } from '@/i18n/format';
import { ArrivalNotice } from '@/components/billing/arrival';
import { RenewalControl } from '@/components/billing/renewal';
import { PayoutCard } from '@/components/payouts/payout-card';
import { I } from '@/components/settings/icon';

/** Current balances, subscriptions, purchases, and payout management. */
export async function BalanceTab({ userId, query }: { userId: string; query: Record<string, string | undefined> }) {
  const { t, locale } = await serverMessages();
  const b = t.billing;
  const [summary, prices] = await Promise.all([billingSummary(userId), currentPricing()]);
  const plan = summary.plan;
  const periodEnd = plan.periodEnd ? formatDate(plan.periodEnd, locale) : '';
  const arriving = typeof query.checkout === 'string' && /^txn_[a-z0-9]{10,64}$/.test(query.checkout) ? query.checkout : null;
  const n = (value: number) => formatNumber(value, locale);
  return (
    <div className={`settings-billing ${summary.official ? 'official-billing' : ''}`}>
      {arriving && <ArrivalNotice transactionId={arriving} />}
      <section className="card billing-total-card" aria-labelledby="billing-total-label">
        <div className="billing-total-main">
          <p className="label" id="billing-total-label">
            {b.total.label}
          </p>
          <p className="billing-total-number">
            <strong>{n(summary.total)}</strong>
            <span>credits</span>
          </p>
          {summary.buckets.welcome > 0 && <p className="billing-total-gift">{fill(b.total.includesWelcome, { n: n(summary.buckets.welcome) })}</p>}
        </div>
        <ul className="billing-buckets" aria-label={b.total.buckets}>
          <li className="billing-bucket">
            <p className="label">
              {b.total.plan.label}
              <span className={`tag ${plan.active ? (plan.cancelAtPeriodEnd ? 'orange' : 'blue') : ''}`}>
                {plan.active ? (plan.cancelAtPeriodEnd ? b.total.plan.ending : b.total.plan.monthly) : b.total.plan.inactive}
              </span>
            </p>
            <p className="billing-bucket-number">{n(summary.buckets.plan)}</p>
            <small>{plan.active ? fill(b.total.plan.expires, { date: periodEnd }) : fill(b.total.plan.idle, { credits: n(prices.plan.credits) })}</small>
          </li>
          <li className="billing-bucket">
            <p className="label">{b.total.welcome.label}</p>
            <p className="billing-bucket-number">{n(summary.buckets.welcome)}</p>
            <small>{b.total.welcome.note}</small>
          </li>
          <li className="billing-bucket">
            <p className="label">
              {b.total.pack.label}
              <I name="layers" />
            </p>
            <p className="billing-bucket-number">{n(summary.buckets.pack)}</p>
            <small>{b.total.pack.note}</small>
          </li>
          {!summary.official && (
            <li className="billing-bucket earned">
              <p className="label">
                {b.total.earned.label}
                <I name="sparkle" />
              </p>
              <p className="billing-bucket-number">{n(summary.buckets.earned)}</p>
              <small>{b.total.earned.note}</small>
            </li>
          )}
        </ul>
      </section>
      {summary.debt > 0 && (
        <div role="note" className="billing-debt">
          <I name="info" />
          <span>{fill(b.debt, { n: n(summary.debt) })}</span>
        </div>
      )}
      <div className="billing-plans mt32">
        <section className="card plan-card primary">
          <div className="between">
            <h3>{b.plan.title}</h3>
            <span className={`tag ${plan.active ? 'blue' : ''}`}>{plan.active ? (plan.cancelAtPeriodEnd ? b.plan.cancelling : b.plan.current) : b.plan.start}</span>
          </div>
          {plan.active && <small>{b.plan.offerPrice}</small>}
          <p className="plan-price">
            <ProductPrice price={prices.plan} kind="plan" locale={locale} labels={t.site.prices} /><small> / {b.plan.per}</small>
          </p>
          <PromotionNotice price={prices.plan} kind="plan" locale={locale} labels={t.site.prices} />
          <p>{fill(b.plan.perCycle, { credits: n(prices.plan.credits) })}</p>
          <Features items={[b.plan.perk1, b.plan.perk2, b.plan.perk3]} />
          {plan.active && <p className="plan-renewal">{fill(plan.cancelAtPeriodEnd ? b.plan.ends : b.plan.renews, { date: periodEnd })}</p>}
          {plan.active ? (
            <RenewalControl cancelAtPeriodEnd={plan.cancelAtPeriodEnd} periodEndLabel={periodEnd} />
          ) : (
            <Link href="/checkout?kind=plan" className="btn">
              {fill(b.plan.subscribe, { price: formatUsd(prices.plan.effectivePriceMinor, locale) })}
            </Link>
          )}
        </section>
        <section className="card plan-card">
          <div className="between">
            <h3>{b.pack.title}</h3>
            <span className="tag">{b.pack.tag}</span>
          </div>
          <p className="plan-price">
            <ProductPrice price={prices.pack} kind="pack" locale={locale} labels={t.site.prices} /><small> / {b.pack.per}</small>
          </p>
          <PromotionNotice price={prices.pack} kind="pack" locale={locale} labels={t.site.prices} />
          <p>{fill(b.pack.perPack, { credits: n(prices.pack.credits) })}</p>
          <Features items={[b.pack.perk1, b.pack.perk2, b.pack.perk3]} />
          {plan.active ? (
            <Link href="/checkout?kind=pack" className="btn secondary">
              {fill(b.pack.buy, { price: formatUsd(prices.pack.effectivePriceMinor, locale) })}
            </Link>
          ) : (
            <button type="button" className="btn secondary" disabled>
              {b.pack.locked}
            </button>
          )}
        </section>
      </div>
      <div className="info-strip mt24">
        <I name="info" />
        <span>{b.info}</span>
      </div>
      <div className="between mt32 mb16">
        <h2 id="payouts" className="section-title payouts-title">
          {t.payouts.card.heading}
        </h2>
      </div>
      <PayoutCard userId={userId} />
    </div>
  );
}

function Features({ items }: { items: string[] }) {
  return (
    <div className="features">
      {items.map((item) => (
        <span key={item}>
          <I name="check" />
          {item}
        </span>
      ))}
    </div>
  );
}
