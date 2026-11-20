import { currentPricing } from '@/lib/services/pricing';
import { ProductPrice, PromotionNotice, pricingFaqValues } from '@/components/site/product-price';
import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { ReactNode } from 'react';
import { welcomeCredits } from '@/lib/services/signup-reward';
import { publicCopyValues } from '@/lib/services/public-copy';
import { videoExportPrice, videoScriptPrice } from '@/lib/services/video-pricing';
import { currentUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { hasActivePlan } from '@/lib/services/billing';
import { serverMessages } from '@/i18n/server';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { Estimator } from '@/components/site/estimator';
import { JsonLd } from '@/components/site/json-ld';
import { pricingJsonLd, publicPage } from '@/lib/seo';
import '@/components/site/pricing.css';

const FAQ = ['q3', 'q4', 'q5', 'q6'] as const;

export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await serverMessages();
  return publicPage({ path: '/pricing', title: t.site.pricing.title, description: t.site.pricing.lede, locale });
}

/**
 * `/pricing` (prototype `#/pricing`): the free trial, Plan and Pack; what
 * credits are spent on; the estimator. A signed-in user without an active
 * Plan sees the Pack button disabled with the reason (2.3). Markup and
 * class names follow the prototype; pricing.css carries its styles.
 */
export default async function PricingPage() {
  const [user, { t, locale }, prices, welcome, scriptPrice, exportPrice] = await Promise.all([
    currentUser(), serverMessages(), currentPricing(), welcomeCredits(), videoScriptPrice(), videoExportPrice(),
  ]);
  const publicValues = await publicCopyValues(t, locale);
  const p = t.site.pricing;
  const planActive = user ? await hasActivePlan(db(), user.id) : false;
  const packLocked = Boolean(user) && !planActive;
  const costs = (['ask', 'process', 'audio', 'script', 'export'] as const).map((key) => p.costs[key]);
  const videoPrices = {
    scriptCredits: formatNumber(scriptPrice.credits, locale),
    exportCredits: formatNumber(exportPrice.credits, locale),
  };
  const faqValues = { ...pricingFaqValues(prices, locale, t.site.prices), ...videoPrices, ...publicValues };
  return (
    <div className="marketing-wrap pricing-page">
      <JsonLd data={pricingJsonLd(prices, locale, p.lede)} />
      <div className="pricing-intro">
        <p className="eyebrow">SMALL PRICE. A WORLD OF KNOWLEDGE.</p>
        <h1>
          {p.headline}
          <em>{p.headlineEm}</em>
        </h1>
        <p>{p.lede}</p>
        <span className="price-rate mono">1 CREDIT = $0.0001</span>
      </div>

      <div className="purchase-plans">
        <PlanCard
          eyebrow={p.free.eyebrow}
          title={p.free.title}
          price="$0"
          grant={formatNumber(welcome.credits, locale)}
          note={p.free.note}
          perks={[p.free.perk1, p.free.perk2, p.free.perk3]}
          action={
            <Link href={user ? '/rees' : '/login'} className="btn secondary full">
              {p.free.cta}
            </Link>
          }
        />
        <PlanCard
          recommended={p.plan.ribbon}
          eyebrow={p.plan.eyebrow}
          title="Plan"
          price={<ProductPrice price={prices.plan} kind="plan" locale={locale} labels={t.site.prices} />}
          promotion={<PromotionNotice price={prices.plan} kind="plan" locale={locale} labels={t.site.prices} />}
          per={p.plan.per}
          grant={formatNumber(prices.plan.credits, locale)}
          grantPer={p.plan.cycle}
          note={p.plan.note}
          perks={[p.plan.perk1, p.plan.perk2, p.plan.perk3]}
          action={
            planActive ? (
              <Link href="/settings?tab=balance" className="btn full">
                {p.plan.manage}
              </Link>
            ) : (
              <Link href="/checkout?kind=plan" className="btn full">
                {p.plan.cta}
                <Icon name="arrow" />
              </Link>
            )
          }
        />
        <PlanCard
          eyebrow={p.pack.eyebrow}
          title="Pack"
          price={<ProductPrice price={prices.pack} kind="pack" locale={locale} labels={t.site.prices} />}
          promotion={<PromotionNotice price={prices.pack} kind="pack" locale={locale} labels={t.site.prices} />}
          per={p.pack.per}
          grant={formatNumber(prices.pack.credits, locale)}
          note={p.pack.note}
          perks={[p.pack.perk1, p.pack.perk2, p.pack.perk3]}
          action={
            packLocked ? (
              <>
                <button type="button" className="btn secondary full" disabled aria-describedby="pack-locked">
                  <Icon name="lock" />
                  {p.pack.locked}
                </button>
                <span id="pack-locked" className="plan-locked">
                  {p.pack.lockedReason}
                </span>
              </>
            ) : (
              <Link href="/checkout?kind=pack" className="btn secondary full">
                {p.pack.cta}
              </Link>
            )
          }
        />
      </div>
      <p className="pricing-redeem">
        <Link href="/settings?tab=balance#redeem" className="text-link">
          {t.billing.redeem.link}
        </Link>
      </p>

      <section className="pricing-costs card">
        <div className="between">
          <div>
            <p className="eyebrow">{p.costs.eyebrow}</p>
            <h2>{p.costs.title}</h2>
          </div>
          <span className="tag blue">{p.costs.tag}</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{p.costs.activity}</th>
                <th>{p.costs.cost}</th>
                <th>{p.costs.details}</th>
              </tr>
            </thead>
            <tbody>
              {costs.map((row) => (
                <tr key={row.activity}>
                  <td>{row.activity}</td>
                  <td>{fill(row.cost, videoPrices)}</td>
                  <td>{row.details}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Estimator planCredits={prices.plan.credits} />

      <section className="home-faq pricing-faq">
        <div>
          <p className="eyebrow">NO SMALL PRINT, JUST CLARITY</p>
          <h2>
            {p.faqTitle1}
            <br />
            {p.faqTitle2}
          </h2>
        </div>
        <div>
          {FAQ.map((key) => (
            <details key={key}>
              <summary>
                {t.site.faq[key].q}
                <Icon name="plus" />
              </summary>
              <p>{fill(t.site.faq[key].a, faqValues)}</p>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}

function PlanCard({
  recommended,
  eyebrow,
  title,
  price,
  promotion,
  per,
  grant,
  grantPer,
  note,
  perks,
  action,
}: {
  recommended?: string;
  eyebrow: string;
  title: string;
  price: ReactNode;
  promotion?: ReactNode;
  per?: string;
  grant: string;
  grantPer?: string;
  note: string;
  perks: string[];
  action: ReactNode;
}) {
  return (
    <article className={`purchase-plan${recommended ? ' recommended' : ''}`}>
      {recommended && <span className="plan-ribbon">{recommended}</span>}
      <span className="eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      <p className="purchase-amount">
        {price}
        {per && (
          <>
            {' '}
            <small>/ {per}</small>
          </>
        )}
      </p>
      {promotion}
      <p className="plan-grant">
        {grant} <span>credits{grantPer ? ` / ${grantPer}` : ''}</span>
      </p>
      <p>{note}</p>
      {action}
      <ul>
        {perks.map((perk) => (
          <li key={perk}>
            <Icon name="check" />
            {perk}
          </li>
        ))}
      </ul>
    </article>
  );
}
