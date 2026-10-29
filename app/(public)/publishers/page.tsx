import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Button, Card, SectionHeading } from '@/components/ui/primitives';
import { PlusIcon } from '@/components/ui/icons';
import { inlineMarkup } from '@/components/site/legal-document';
import { currentPlanVersion } from '@/lib/application/plans';
import {
  creditCallsFor,
  DAILY_ATTRIBUTABLE_CALL_CAP,
  PAYOUT_HOLD_DAYS,
  PAYOUT_THRESHOLD_MINOR,
} from '@/lib/domain';
import { FALLBACK_PRICING, type PricedVersion } from '@/lib/domain/pricing-page';
import type { PlanTierId } from '@/lib/domain/plans';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { publishers } = await getMessages();
  return { title: publishers.metaTitle, description: publishers.metaDescription };
}

/* Example 2's platform: 100 Pro subscribers using half their allowance, a tenth of it on your library. */
const EXAMPLE_SUBSCRIBERS = 100;

/** Anchor ids, in the order the sections run. */
const SECTION_IDS = ['eligible', 'formula', 'examples', 'timeline', 'anti-abuse', 'principles'] as const;

/**
 * The live version of a tier, or the seed's figures when there is none or the
 * database cannot be read: the page is public, so it renders the seeded
 * examples rather than an error, the way the pricing page does.
 */
async function liveVersion(tier: PlanTierId): Promise<PricedVersion> {
  try {
    return (await currentPlanVersion(tier)) ?? FALLBACK_PRICING[tier];
  } catch (error) {
    console.error(`publishers: plan ${tier} unreadable: ${error instanceof Error ? error.message : 'unknown'}`);
    return FALLBACK_PRICING[tier];
  }
}

function usd(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

/** Fractions of a cent, which `usd` would print as $0.00. */
function fine(minor: number): string {
  return `$${new Intl.NumberFormat('en-US', { maximumSignificantDigits: 2 }).format(minor / 100)}`;
}

/**
 * The revenue rules, as a public document. publisher-revenue-share.md 3-5 for
 * a publisher: which retrievals earn, the formula, worked examples, when the
 * money can be used and what voids it. Public so a prospective publisher reads
 * them before publishing anything; the home page's publisher section, the
 * pricing page and the dashboard's revenue page all link here. The examples are
 * priced from the plan versions in force and the constants the ledger
 * enforces, so they move with the console instead of going stale in the copy;
 * the arithmetic mirrors closePeriod and creditCallsFor, rounded down to the
 * cent the same way.
 */
export default async function PublishersPage() {
  const [{ locale, t }, pro, pack] = await Promise.all([
    translations(),
    liveVersion('pro'),
    liveVersion('addon'),
  ]);
  const d = t.publishers;
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' });
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 });

  const rateBps = pro.shareRateBps;

  /* Example 1: full usage, so one retrieval is the price over the allowance. */
  const perCallRevenueMinor = pro.priceMinor / pro.monthlyCalls;
  const perCallMinor = (perCallRevenueMinor * rateBps) / 10_000;

  /* Example 2: the formula with half the allowance used. */
  const revenueMinor = EXAMPLE_SUBSCRIBERS * pro.priceMinor;
  const totalCalls = Math.floor((EXAMPLE_SUBSCRIBERS * pro.monthlyCalls) / 2);
  const libraryCalls = Math.floor(totalCalls / 10);
  const poolMinor = Math.floor((revenueMinor * rateBps) / 10_000);
  const earningMinor = Math.floor((poolMinor * libraryCalls) / totalCalls);

  /* Example 5: this month's period, closed on the 3rd of the next. */
  const now = new Date();
  const lockAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 3));
  const releaseAt = new Date(lockAt.getTime() + PAYOUT_HOLD_DAYS * 86_400_000);

  const values = {
    rate: percent.format(rateBps / 10_000),
    holdDays: PAYOUT_HOLD_DAYS,
    cap: number.format(DAILY_ATTRIBUTABLE_CALL_CAP),
    threshold: usd(PAYOUT_THRESHOLD_MINOR),
    proPrice: usd(pro.priceMinor),
    proCalls: number.format(pro.monthlyCalls),
    perCallRevenue: fine(perCallRevenueMinor),
    perCall: fine(perCallMinor),
    callsPerDollar: number.format(Math.round(100 / perCallMinor)),
    revenue: usd(revenueMinor),
    totalCalls: number.format(totalCalls),
    libraryCalls: number.format(libraryCalls),
    pool: usd(poolMinor),
    share: percent.format(libraryCalls / totalCalls),
    earning: usd(earningMinor),
    perCallMonth: fine(earningMinor / libraryCalls),
    readerCalls: number.format(DAILY_ATTRIBUTABLE_CALL_CAP + 300),
    overCalls: number.format(300),
    lockDate: date.format(lockAt),
    releaseDate: date.format(releaseAt),
    packPrice: usd(pack.priceMinor),
    packCalls: number.format(pack.monthlyCalls),
    redeemCalls: number.format(
      creditCallsFor(earningMinor, { priceMinor: pack.priceMinor, calls: pack.monthlyCalls }),
    ),
  };
  const say = (template: string) => inlineMarkup(fill(template, values));

  const examples = [
    d.examples.single,
    d.examples.month,
    d.examples.cap,
    d.examples.related,
    d.examples.redeem,
  ];
  const titles = [
    d.eligible.title,
    d.formula.title,
    d.examples.title,
    d.timeline.title,
    d.antiAbuse.title,
    d.principles.title,
  ];
  const contents = SECTION_IDS.map((id, i) => ({ id, title: titles[i] }));

  return (
    <div className="mx-auto w-full max-w-[1200px]">
      <section className="px-5 pt-11 pb-12">
        <SectionHeading eyebrow="PUBLISHERS" title={d.title} as="h1" size="lg" />
        <p className="mt-3 max-w-[70ch] text-[13px] leading-[1.7] text-muted">{d.description}</p>

        <div className="mt-7 grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section className="flex flex-col gap-2 rounded-lg border border-brand/30 bg-brandsoft px-6 py-5">
            <h2 className="text-[13px] leading-[1.4] font-medium text-brandink">{d.summaryTitle}</h2>
            <p className="text-[14px] leading-[1.8] text-ink">{say(d.summary)}</p>
          </section>

          <Card className="p-6">
            <ol className="flex flex-col gap-2.5">
              {contents.map((section, i) => (
                <li key={section.id}>
                  <a href={`#${section.id}`} className="group flex items-baseline gap-3">
                    <span className="font-mono text-[11px] text-faint">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="text-[13px] font-medium text-ink group-hover:text-brandink">
                      {section.title}
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </section>

      <Section id="eligible" title={d.eligible.title}>
        <p className={BODY}>{d.eligible.lead}</p>
        <List items={d.eligible.items.map(say)} ordered />
      </Section>

      <Section id="formula" title={d.formula.title}>
        <p className={BODY}>{d.formula.lead}</p>
        <p className="rounded-md border border-line bg-subtle px-4 py-3.5 text-[14px] leading-[1.7] font-medium text-ink">
          {say(d.formula.expression)}
        </p>
        <List items={d.formula.notes.map(say)} />
        <p className={BODY}>{say(d.formula.consequence)}</p>
      </Section>

      <Section id="examples" title={d.examples.title}>
        <p className={BODY}>{say(d.examples.note)}</p>
        <div className="grid gap-3.5 md:grid-cols-2">
          {examples.map((example) => (
            <Card key={example.title} className="flex flex-col gap-2.5 p-5">
              <h3 className="text-[14px] leading-[1.4] font-medium text-ink">{say(example.title)}</h3>
              <p className={BODY}>{say(example.scenario)}</p>
              <div className="flex flex-col gap-1 rounded bg-subtle px-3.5 py-3 font-mono text-[12px] leading-[1.7] text-steel">
                {example.lines.map((line) => (
                  <span key={line}>{say(line)}</span>
                ))}
              </div>
              <p className="text-[13px] leading-[1.7] text-ink">{say(example.result)}</p>
            </Card>
          ))}
        </div>
      </Section>

      <Section id="timeline" title={d.timeline.title}>
        <ol className="flex flex-col">
          {d.timeline.steps.map((step, i) => (
            <li key={step.title} className="flex gap-3.5">
              <div className="flex flex-col items-center">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brandsoft text-[12px] font-medium text-brandink">
                  {i + 1}
                </span>
                {i < d.timeline.steps.length - 1 ? <span className="w-px flex-1 bg-line" /> : null}
              </div>
              <div className="flex flex-col gap-1 pb-5">
                <h3 className="text-[14px] leading-7 font-medium text-ink">{say(step.title)}</h3>
                <p className={BODY}>{say(step.body)}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="anti-abuse" title={d.antiAbuse.title}>
        <p className={BODY}>{d.antiAbuse.lead}</p>
        <List items={d.antiAbuse.items.map(say)} />
        <p className={BODY}>{d.antiAbuse.voidLead}</p>
        <List items={d.antiAbuse.voidItems.map(say)} />
      </Section>

      <Section id="principles" title={d.principles.title}>
        <List items={d.principles.items.map(say)} />
      </Section>

      <section className="border-t border-line px-5 pt-12 pb-16">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <div className="flex flex-col gap-2">
            <span className="eyebrow">{d.closing.eyebrow}</span>
            <h2 className="max-w-[26ch] text-heading-sm font-semibold tracking-[0.018em] text-ink">
              {d.closing.title}
            </h2>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button href="/dashboard/revenue" variant="outline" size="md">
              {d.closing.earnings}
            </Button>
            <Button href="/libraries/claim" size="md">
              <PlusIcon size={15} />
              {d.closing.submit}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

const BODY = 'max-w-[80ch] text-[13px] leading-[1.8] text-muted';

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-[78px] flex-col gap-4 border-t border-line px-5 pt-11 pb-12">
      <h2 className="text-[21px] leading-[1.3] font-medium text-ink">{title}</h2>
      {children}
    </section>
  );
}

function List({ items, ordered = false }: { items: ReactNode[]; ordered?: boolean }) {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag
      className={`flex flex-col gap-2 pl-5 ${ordered ? 'list-decimal' : 'list-disc'} ${BODY} marker:text-faint`}
    >
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </Tag>
  );
}
