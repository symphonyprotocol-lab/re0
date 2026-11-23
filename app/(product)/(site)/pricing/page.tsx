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
import { publicPage } from '@/lib/seo';
import { pricingJsonLd } from '@/lib/jsonld';
import { ContentPage } from '@/components/site/content-page';

const FAQ = ['q3', 'q4', 'q7', 'q9', 'q5', 'q6'] as const;

export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await serverMessages();
  return publicPage({ path: '/pricing', title: t.site.pricing.title, description: t.site.pricing.lede, locale });
}

/**
 * `/pricing`: the free trial, Plan and Pack; what credits are spent on
 * (with public posts, v6); the estimator; the questions. A signed-in user
 * without an active Plan sees the Pack button disabled with the reason
 * (2.3). In the shell's wide column since v6 (content-page.css).
 */
export default async function PricingPage() {
  const [user, { t, locale }, prices, welcome, scriptPrice, exportPrice] = await Promise.all([
    currentUser(), serverMessages(), currentPricing(), welcomeCredits(), videoScriptPrice(), videoExportPrice(),
  ]);
  const publicValues = await publicCopyValues(t, locale);
  const p = t.site.pricing;
  const planActive = user ? await hasActivePlan(db(), user.id) : false;
  const packLocked = Boolean(user) && !planActive;
  /* Public posts (v6): publishing, each answer and the round-table summary, after asking a Ree; then the AI's general answer when no Ree can answer. */
  const costs = (['ask', 'postPublish', 'postAnswer', 'postSummary', 'aiAnswer', 'process', 'audio', 'script', 'export'] as const).map((key) => p.costs[key]);
  const videoPrices = {
    scriptCredits: formatNumber(scriptPrice.credits, locale),
    exportCredits: formatNumber(exportPrice.credits, locale),
  };
  const faqValues = { ...pricingFaqValues(prices, locale, t.site.prices), ...videoPrices, ...publicValues };
  const rowValues = { ...videoPrices, ...publicValues };
  return (
    <ContentPage title={p.title}>
      <JsonLd data={pricingJsonLd(prices, locale, p.lede)} />
      <section>
        <p className="eyebrow">SMALL PRICE. A WORLD OF KNOWLEDGE.</p>
        <h2 className="xpage-headline mt-2">
          {p.headline}
          <em>{p.headlineEm}</em>
        </h2>
        <p className="xpage-lede mt-2">
          {p.lede}
          <span className="tag">1 CREDIT = $0.0001</span>
        </p>
      </section>

      <div className="xp-grid3">
        <PlanCard
          eyebrow={p.free.eyebrow}
          title={p.free.title}
          price="$0"
          grant={formatNumber(welcome.credits, locale)}
          note={p.free.note}
          perks={[p.free.perk1, p.free.perk2, p.free.perk3]}
          action={
            <Link href={user ? '/rees' : '/login'} className="btn-secondary btn-sm">
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
              <Link href="/settings?tab=balance" className="btn btn-sm">
                {p.plan.manage}
              </Link>
            ) : (
              <Link href="/checkout?kind=plan" className="btn btn-sm">
                {p.plan.cta}
                <Icon name="arrow" className="size-4" />
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
                <button type="button" className="btn-secondary btn-sm" disabled aria-describedby="pack-locked">
                  <Icon name="lock" className="size-4" />
                  {p.pack.locked}
                </button>
                <span id="pack-locked" className="xp-locked">
                  {p.pack.lockedReason}
                </span>
              </>
            ) : (
              <Link href="/checkout?kind=pack" className="btn-secondary btn-sm">
                {p.pack.cta}
              </Link>
            )
          }
        />
      </div>
      <p className="text-center">
        <Link href="/settings?tab=balance#redeem" className="text-link">
          {t.billing.redeem.link}
        </Link>
      </p>

      <section className="xp-card">
        <div className="xp-head">
          <p className="eyebrow">{p.costs.eyebrow}</p>
          <h2>{p.costs.title}</h2>
          <span className="tag blue">{p.costs.tag}</span>
        </div>
        <div className="xp-table-wrap">
          <table className="xp-table">
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
                  <td>{fill(row.cost, rowValues)}</td>
                  <td>{fill(row.details, rowValues)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Estimator planCredits={prices.plan.credits} />

      <section className="xp-card">
        <div className="xp-head">
          <p className="eyebrow">NO SMALL PRINT, JUST CLARITY</p>
          <h2>
            {p.faqTitle1}
            {p.faqTitle2}
          </h2>
        </div>
        <div className="xp-faq">
          {FAQ.map((key) => (
            <details key={key} id={`faq-${key}`}>
              <summary>
                {t.site.faq[key].q}
                <Icon name="plus" />
              </summary>
              <p>{fill(t.site.faq[key].a, faqValues)}</p>
            </details>
          ))}
        </div>
      </section>
    </ContentPage>
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
    <article className={`xp-tier${recommended ? ' is-recommended' : ''}`}>
      {recommended && <span className="tag blue xp-ribbon">{recommended}</span>}
      <span className="eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      <div>
        <p className="xp-price">
          {price}
          {per && <small>/ {per}</small>}
        </p>
        {promotion}
      </div>
      <p className="xp-credits">
        {grant} credits{grantPer ? ` / ${grantPer}` : ''}
      </p>
      <p className="xp-note">{note}</p>
      <div className="xp-action">{action}</div>
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
