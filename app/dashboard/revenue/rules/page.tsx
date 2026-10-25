import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { BackLink, PANEL, PageHeader } from '@/components/dashboard/ui';
import { inlineMarkup } from '@/components/site/legal-document';
import { currentPlanVersion } from '@/lib/application/plans';
import {
  creditCallsFor,
  DAILY_ATTRIBUTABLE_CALL_CAP,
  PAYOUT_HOLD_DAYS,
  PAYOUT_THRESHOLD_MINOR,
} from '@/lib/domain';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.revenueRules.metaTitle };
}

/*
 * What the seed migration (0002, 0007) ships, for the one case where no
 * version of a tier exists yet. Every deployment has both from its first
 * migration, so this only keeps the page from breaking on a stripped database.
 */
const SEEDED_PRO = { priceMinor: 500, monthlyCalls: 5_000, shareRateBps: 2_000 };
const SEEDED_PACK = { priceMinor: 500, monthlyCalls: 5_000 };

/* Example 2's platform: 100 Pro subscribers using half their allowance, a tenth of it on your library. */
const EXAMPLE_SUBSCRIBERS = 100;

function usd(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

/** Fractions of a cent, which `usd` would print as $0.00. */
function fine(minor: number): string {
  return `$${new Intl.NumberFormat('en-US', { maximumSignificantDigits: 2 }).format(minor / 100)}`;
}

/**
 * The revenue rules, as a document. publisher-revenue-share.md 3-5 for a
 * publisher: which retrievals earn, the formula, worked examples, when the
 * money can be used and what voids it. The examples are priced from the plan
 * versions in force and the constants the ledger enforces, so they move with
 * the console instead of going stale in the copy; the arithmetic mirrors
 * closePeriod and creditCallsFor, rounded down to the cent the same way.
 */
export default async function RevenueRulesPage() {
  const [, { locale, t }, proVersion, packVersion] = await Promise.all([
    requireSession('/dashboard/revenue/rules'),
    translations(),
    currentPlanVersion('pro'),
    currentPlanVersion('addon'),
  ]);
  const d = t.dashboard.revenueRules;
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' });
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 });

  const pro = proVersion ?? SEEDED_PRO;
  const pack = packVersion ?? SEEDED_PACK;
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

  return (
    <div className="flex max-w-[860px] flex-col gap-4">
      <BackLink href="/dashboard/revenue">{d.back}</BackLink>
      <PageHeader eyebrow={d.eyebrow} title={d.title} description={d.description} />

      <section className="flex flex-col gap-1.5 rounded-lg border border-brand/30 bg-brandsoft px-[18px] py-4">
        <h2 className="text-[13px] leading-[1.4] font-medium text-brandink">{d.summaryTitle}</h2>
        <p className="text-[13px] leading-[1.75] text-ink">{say(d.summary)}</p>
      </section>

      <Section title={d.eligible.title}>
        <p className={BODY}>{d.eligible.lead}</p>
        <List items={d.eligible.items.map(say)} ordered />
      </Section>

      <Section title={d.formula.title}>
        <p className={BODY}>{d.formula.lead}</p>
        <p className="rounded-md border border-line bg-subtle px-3.5 py-3 text-[13px] leading-[1.7] font-medium text-ink">
          {say(d.formula.expression)}
        </p>
        <List items={d.formula.notes.map(say)} />
        <p className={BODY}>{say(d.formula.consequence)}</p>
      </Section>

      <Section title={d.examples.title}>
        <p className={BODY}>{say(d.examples.note)}</p>
        <div className="flex flex-col gap-3">
          {examples.map((example) => (
            <article
              key={example.title}
              className="flex flex-col gap-2 rounded-md border border-line px-3.5 py-3"
            >
              <h3 className="text-[13px] leading-[1.4] font-medium text-ink">{say(example.title)}</h3>
              <p className={BODY}>{say(example.scenario)}</p>
              <div className="flex flex-col gap-1 rounded bg-subtle px-3 py-2.5 font-mono text-[12px] leading-[1.7] text-steel">
                {example.lines.map((line) => (
                  <span key={line}>{say(line)}</span>
                ))}
              </div>
              <p className="text-[12.5px] leading-[1.7] text-ink">{say(example.result)}</p>
            </article>
          ))}
        </div>
      </Section>

      <Section title={d.timeline.title}>
        <ol className="flex flex-col">
          {d.timeline.steps.map((step, i) => (
            <li key={step.title} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brandsoft text-[11px] font-medium text-brandink">
                  {i + 1}
                </span>
                {i < d.timeline.steps.length - 1 ? <span className="w-px flex-1 bg-line" /> : null}
              </div>
              <div className="flex flex-col gap-0.5 pb-4">
                <h3 className="text-[13px] leading-6 font-medium text-ink">{say(step.title)}</h3>
                <p className={BODY}>{say(step.body)}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section title={d.antiAbuse.title}>
        <p className={BODY}>{d.antiAbuse.lead}</p>
        <List items={d.antiAbuse.items.map(say)} />
        <p className={BODY}>{d.antiAbuse.voidLead}</p>
        <List items={d.antiAbuse.voidItems.map(say)} />
      </Section>

      <Section title={d.principles.title}>
        <List items={d.principles.items.map(say)} />
      </Section>
    </div>
  );
}

const BODY = 'text-[12.5px] leading-[1.75] text-steel';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={`${PANEL} flex flex-col gap-3 px-[18px] py-4`}>
      <h2 className="text-[16px] leading-[1.5] text-ink">{title}</h2>
      {children}
    </section>
  );
}

function List({ items, ordered = false }: { items: ReactNode[]; ordered?: boolean }) {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag
      className={`flex flex-col gap-1.5 pl-5 ${ordered ? 'list-decimal' : 'list-disc'} ${BODY} marker:text-muted`}
    >
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </Tag>
  );
}
