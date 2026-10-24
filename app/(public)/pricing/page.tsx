import type { Metadata } from 'next';
import { cache, type ReactNode } from 'react';
import Link from 'next/link';
import { PendingSubmitButton } from '@/components/ui/pending-submit-button';
import { SectionHeading } from '@/components/ui/primitives';
import { JsonLd } from '@/components/seo/json-ld';
import { PUBLIC_ORIGIN, publicUrl } from '@/lib/site/origin';
import {
  ArrowRightIcon,
  CheckIcon,
  CircleHelpIcon,
  GiftIcon,
  PackagePlusIcon,
  SparklesIcon,
} from '@/components/ui/icons';
import { currentPlanVersion } from '@/lib/application/plans';
import { FALLBACK_PRICING, pricingFigures, type PricedVersion, type PricingVersions } from '@/lib/domain/pricing-page';
import type { PlanTierId } from '@/lib/domain/plans';
import { fill } from '@/lib/i18n/format';
import { translations } from '@/lib/i18n/server';
import { startCheckoutAction } from '@/app/dashboard/settings/actions';

export async function generateMetadata(): Promise<Metadata> {
  const [{ locale, t }, versions] = await Promise.all([translations(), livePricing()]);
  const figures = pricingFigures(versions, new Intl.NumberFormat(locale), t.pricing.surfaces);
  return {
    title: t.pricing.metaTitle,
    description: fill(t.pricing.metaDescription, { freeCalls: figures.free.calls, proPrice: figures.pro.price }),
  };
}

/**
 * The live version of each tier, or the seed's figures for a tier that has
 * none (`FALLBACK_PRICING`). A database that cannot be read renders the
 * seed's figures rather than an error page: the page is public and cached.
 */
/* Metadata and the page share one read per request. */
const livePricing = cache(async (): Promise<PricingVersions> => {
  /* Read per request (the page reads the locale cookie), so a version saved in the console shows at once. */
  const read = async (tier: PlanTierId): Promise<PricedVersion> => {
    try {
      return (await currentPlanVersion(tier)) ?? FALLBACK_PRICING[tier];
    } catch (error) {
      console.error(`pricing: plan ${tier} unreadable: ${error instanceof Error ? error.message : 'unknown'}`);
      return FALLBACK_PRICING[tier];
    }
  };
  const [free, pro, addon] = await Promise.all([read('free'), read('pro'), read('addon')]);
  return { free, pro, addon };
});

/** Identity and icon per plan; the words come from the dictionary, the figures from the live versions. */
/**
 * Each card's button goes where that plan is acted on. Free is a link to the
 * dashboard; the paid two post straight to the checkout action, so a signed-in
 * buyer lands on the provider's checkout without a stop on the settings page.
 * The action sends a signed-out visitor through login to the settings plan
 * card, and a refusal (a pack before Pro, a second subscription) to the same
 * card with the reason printed.
 */
const PLAN_FACTS = [
  {
    id: 'free',
    name: 'Free',
    icon: <GiftIcon size={18} />,
    featured: false,
    href: '/dashboard',
  },
  {
    id: 'pro',
    name: 'Pro',
    icon: <SparklesIcon size={18} />,
    featured: true,
    checkout: 'subscription',
  },
  {
    id: 'addon',
    name: 'Additional Calls',
    icon: <PackagePlusIcon size={18} />,
    featured: false,
    checkout: 'pack',
  },
] as const;

const PLAN_BUTTON =
  'flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors';
const PLAN_BUTTON_FEATURED = 'bg-brand text-onbrand hover:bg-brand/90';
const PLAN_BUTTON_PLAIN = 'border border-line bg-surface text-ink hover:bg-subtle';

/** The grey banner that closes a run of sections; teal is left to its accents. */
function CtaBanner({
  eyebrow,
  title,
  cta,
  href,
  className = '',
}: {
  eyebrow: string;
  title: string;
  cta: string;
  href: string;
  /** Spacing above, when the preceding section does not already provide it. */
  className?: string;
}) {
  return (
    <div className={`mx-auto w-full max-w-[1200px] px-5 ${className}`}>
      <section className="flex flex-wrap items-center justify-between gap-7 rounded-md bg-panel px-10 py-[34px] shadow-md md:h-[150px] md:flex-nowrap md:py-0">
        <div className="flex flex-col gap-[11px] pt-2">
          <p className="text-[11px] font-medium text-brandink">{eyebrow}</p>
          <h2 className="text-[25px] leading-[1.5] font-medium text-ink">
            {title}
          </h2>
        </div>
        <Link
          href={href}
          className="flex h-10 shrink-0 items-center justify-center gap-2 rounded-full bg-brand px-[18px] text-sm font-medium text-onbrand transition-colors hover:bg-brand/90"
        >
          {cta}
          <ArrowRightIcon size={15} />
        </Link>
      </section>
    </div>
  );
}

export default async function PricingPage() {
  const [{ locale, t }, versions] = await Promise.all([translations(), livePricing()]);
  const p = t.pricing;
  const number = new Intl.NumberFormat(locale);
  const figures = pricingFigures(versions, number, p.surfaces);
  const plans = PLAN_FACTS.map((facts) => {
    const words = p.plans[facts.id];
    const values = figures[facts.id];
    return {
      ...facts,
      ...words,
      price: values.price,
      calls: fill(words.calls, values),
      points: words.points.map((point) => fill(point, values)),
    };
  });
  const r = p.compareRows;
  const { free, pro, addon } = figures;
  const compare: [string, string, string, string][] = [
    [r.price, free.price, pro.price, fill(r.pricePack, { price: addon.price })],
    [r.calls, fill(r.callsMonthly, free), fill(r.callsMonthly, pro), fill(r.callsPack, addon)],
    [r.publicLibraries, r.allIncluded, r.allIncluded, r.inherits],
    [r.ownLibraries, fill(r.upTo, { n: free.libraries }), fill(r.upTo, { n: pro.libraries }), r.inherits],
    [r.size, free.size, pro.size, r.inherits],
    [r.widget, free.siteKeys, pro.siteKeys, r.inherits],
    [r.pages, free.showcasePages, pro.showcasePages, r.inherits],
    [r.builds, fill(r.buildRate, free), fill(r.buildRate, pro), r.inherits],
    [r.packs, r.none, r.packsAvailable, r.packsSelf],
    [r.tokens, '$0', '$0', '$0'],
  ];
  const faq = p.faq.map((item) => ({
    q: item.q,
    a: fill(item.a, {
      packCalls: addon.calls,
      freeLibraries: free.libraries,
      freeSize: free.size,
      proLibraries: pro.libraries,
      proSize: pro.size,
      freeSurfaces: free.surfaces,
      proSurfaces: pro.surfaces,
      base: pro.base,
      tokens: pro.tokens,
      pages: pro.pages,
      share: pro.share,
    }),
  }));

  /* The three prices as a search engine reads them: the same figures the
     cards print, taken from the same facts, so the two cannot drift apart. */
  const offers = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Re0',
    url: PUBLIC_ORIGIN,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Web',
    description: fill(p.metaDescription, { freeCalls: free.calls, proPrice: pro.price }),
    offers: plans.map((plan) => ({
      '@type': 'Offer',
      name: plan.name,
      description: plan.calls,
      price: plan.price.replace('$', '').replace(/,/g, ''),
      priceCurrency: 'USD',
      url: publicUrl('/pricing'),
    })),
  };

  return (
    <>
      <JsonLd data={offers} />
      {/*
        * Plans and the comparison table share one tinted band. The negative
        * margin pulls it up behind the floating header capsule (54px pill plus
        * its 12px gutters) and the matching padding puts the content back, so
        * the tint starts at the very top of the page rather than under the
        * header.
        */}
      <div className="-mt-[78px] bg-subtle pt-[78px]">
        <section className="mx-auto w-full max-w-[1200px] px-5 pt-[50px] pb-[70px]">
          <SectionHeading
            eyebrow="PLANS"
            title={p.title}
            as="h1"
            action={<p className="text-[11px] text-muted">{p.headerNote}</p>}
          />

          <div className="mt-3.5 grid gap-3.5 md:grid-cols-3">
            {plans.map((plan) => (
              <article
                key={plan.id}
                className={`flex flex-col rounded-lg border bg-card p-6 shadow-md ${
                  plan.featured ? 'border-brand/70' : 'border-line'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="flex size-[34px] shrink-0 items-center justify-center rounded-lg border border-brandline bg-brandsoft text-brandink">
                    {plan.icon}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-medium whitespace-nowrap ${
                      plan.featured ? 'bg-brand text-onbrand' : 'bg-brandsoft text-brandink'
                    }`}
                  >
                    {plan.kicker}
                  </span>
                </div>

                <h3 className="mt-[23px] text-[18px] leading-[1.5] font-medium text-ink">
                  {plan.name}
                </h3>

                <p className="mt-[9px] flex items-end gap-[7px]">
                  <span className="text-[48px] leading-none font-medium text-ink">
                    {plan.price}
                  </span>
                  <span className="pb-1.5 text-[11px] text-muted">{plan.unit}</span>
                </p>

                <p className="mt-3.5 self-start rounded-md bg-mutedbg px-[9px] py-1.5 text-[16px] leading-[1.5] text-steel">
                  {plan.calls}
                </p>

                <p className="mt-3.5 min-h-10 text-[12px] leading-[1.65] text-muted">
                  {plan.blurb}
                </p>

                <ul className="mt-[17px] flex flex-col gap-[11px] border-t border-line pt-[19px] text-[11px] leading-[1.5] text-steel">
                  {plan.points.map((point) => (
                    <li key={point} className="flex items-center gap-2">
                      <CheckIcon size={14} className="text-brandink" />
                      {point}
                    </li>
                  ))}
                </ul>

                <div className="mt-auto pt-[22px]">
                  {'checkout' in plan ? (
                    <form action={startCheckoutAction}>
                      <input type="hidden" name="kind" value={plan.checkout} />
                      <PendingSubmitButton
                        className={`${PLAN_BUTTON} ${plan.featured ? PLAN_BUTTON_FEATURED : PLAN_BUTTON_PLAIN}`}
                      >
                        {plan.cta}
                      </PendingSubmitButton>
                    </form>
                  ) : (
                    <Link
                      href={plan.href}
                      className={`${PLAN_BUTTON} ${plan.featured ? PLAN_BUTTON_FEATURED : PLAN_BUTTON_PLAIN}`}
                    >
                      {plan.cta}
                      <ArrowRightIcon size={14} />
                    </Link>
                  )}
                </div>
              </article>
            ))}
          </div>

          <p className="mt-3.5 flex items-center justify-center gap-2 rounded-lg border border-line bg-brandsoft/60 px-[17px] py-[15px] text-center text-[11px] leading-[1.5] text-steel">
            <span aria-hidden className="font-medium text-brandink">
              $
            </span>
            {p.callNote}
          </p>
        </section>

        <div className="mx-auto w-full max-w-[1200px] px-5 pt-16 pb-18">
          <SectionHeading
            eyebrow="COMPARE"
            title={p.compareTitle}
            action={<p className="text-[11px] text-muted">{p.compareNote}</p>}
          />

          <div className="mt-[25px] overflow-hidden rounded-md border border-line bg-card p-0.5">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] table-fixed text-left">
                <colgroup>
                  <col className="w-[32.2%]" />
                  <col className="w-[22.2%]" />
                  <col className="w-[22.2%]" />
                  <col className="w-[23.4%]" />
                </colgroup>
                <thead>
                  <tr className="h-[42px] border-b border-line bg-mutedbg text-[10px] text-muted">
                    <th className="px-[17px] font-normal">{p.compareHeadCapability}</th>
                    <th className="px-[17px] font-medium">FREE</th>
                    <th className="px-[17px] font-medium text-brandink">PRO</th>
                    <th className="px-[17px] font-medium">ADDITIONAL CALLS</th>
                  </tr>
                </thead>
                <tbody className="text-[11px]">
                  {compare.map((row, i) => (
                    <tr
                      key={row[0]}
                      className={`h-[54px] ${i === compare.length - 1 ? '' : 'border-b border-line'}`}
                    >
                      <td className="px-[17px] font-medium text-ink">{row[0]}</td>
                      <td className="px-[17px] text-steel">{row[1]}</td>
                      <td className="px-[17px] font-medium text-brandink">{row[2]}</td>
                      <td className="px-[17px] text-steel">{row[3]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/*
        * The compare band ends in a hard rule, so this banner needs the breathing
        * room the FAQ's bottom padding gives the one below it.
        */}
      <CtaBanner
        eyebrow={p.shareBanner.eyebrow}
        title={p.shareBanner.title}
        cta={p.shareBanner.cta}
        href="/contact"
        className="mt-[68px]"
      />

      <section className="mx-auto flex w-full max-w-[1200px] flex-col gap-10 px-5 py-[68px] md:flex-row md:gap-[72px]">
        <div className="md:w-[300px] md:shrink-0">
          <CircleHelpIcon size={20} className="text-brandink" />
          <p className="mt-[13px] text-[10px] font-medium tracking-[0.1em] text-brandink">FAQ</p>
          <h2 className="mt-[7px] text-[28px] leading-[1.5] font-medium text-ink">
            {p.faqTitle}
          </h2>
          <p className="mt-2.5 text-[12px] leading-[1.65] text-muted">
            {p.faqNote}
          </p>
        </div>

        <dl className="min-w-0 flex-1 border-t border-line pt-0.5">
          {faq.map((item) => (
            <div key={item.q} className="flex flex-col gap-[7px] border-b border-line pt-[18px] pb-5">
              <dt className="text-[13px] leading-[1.5] font-medium text-ink">
                {item.q}
              </dt>
              <dd className="text-[11px] leading-[1.65] text-muted">{item.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <CtaBanner
        eyebrow={p.freeBanner.eyebrow}
        title={p.freeBanner.title}
        cta={p.freeBanner.cta}
        href="/libraries"
      />

      <div aria-hidden className="h-[62px]" />
    </>
  );
}
