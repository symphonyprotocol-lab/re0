import Link from 'next/link';
import type { ReactNode } from 'react';
import { LIST_PAGE_SIZES } from '@/lib/constants';
import { parseActivity } from '@/lib/http/billing';
import { billingSummary, listEntries } from '@/lib/services/billing';
import { serverMessages } from '@/i18n/server';
import { fill, formatDate, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ArrivalNotice } from '@/components/billing/arrival';
import { Entries } from '@/components/billing/entries';
import { RenewalControl } from '@/components/billing/renewal';
import { PayoutCard } from '@/components/payouts/payout-card';

/**
 * `/settings?tab=billing` (prototype app.js `billing`): total balance, the
 * welcome strip, Plan / Pack / earned balances, the Plan and Pack cards with
 * renewal control, the ledger, and (step 6) the payout card. Official
 * accounts get no earned card and no income in the ledger.
 */
export async function BillingTab({ userId, query }: { userId: string; query: Record<string, string | undefined> }) {
  const { t, locale } = await serverMessages();
  const b = t.billing;
  const listQuery = parseActivity(query, LIST_PAGE_SIZES);
  const [summary, entries] = await Promise.all([billingSummary(userId), listEntries(userId, listQuery)]);
  const plan = summary.plan;
  const periodEnd = plan.periodEnd ? formatDate(plan.periodEnd, locale) : '';
  const arriving = typeof query.checkout === 'string' && /^txn_[a-z0-9]{10,64}$/.test(query.checkout) ? query.checkout : null;
  const n = (value: number) => formatNumber(value, locale);
  return (
    <div className="flex flex-col gap-5">
      {arriving && <ArrivalNotice transactionId={arriving} />}
      <div className="flex items-baseline justify-end gap-2">
        <span className="text-[12px] text-muted">{b.total}</span>
        <strong className="font-mono text-[26px]">{n(summary.total)}</strong>
        <span className="text-[12px] text-muted">credits</span>
      </div>
      {summary.buckets.welcome > 0 && (
        <p className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#e6e0f7] bg-[#f7f4ff] px-4 py-2.5 text-[12px]">
          <span className="flex items-center gap-2">
            <Icon name="sparkle" className="size-4 text-[#8a6bd1]" />
            {fill(b.welcome, { n: n(summary.buckets.welcome) })}
          </span>
          <span className="text-muted">{b.noExpiry}</span>
        </p>
      )}
      {summary.debt > 0 && (
        <p role="note" className="flex items-start gap-2 rounded-xl border border-[#f3e2c6] bg-[#fdf7ec] px-4 py-2.5 text-[12px] text-orange">
          <Icon name="info" className="mt-0.5 size-4 flex-none" />
          {fill(b.debt, { n: n(summary.debt) })}
        </p>
      )}
      <div className={`grid gap-4 ${summary.official ? 'md:grid-cols-2' : 'md:grid-cols-3'}`}>
        <BalanceCard
          label={b.planBalance.label}
          tag={<span className={`tag ${plan.active ? 'border-[#d8e6fb] bg-soft text-blue' : ''}`}>{plan.active ? b.planBalance.monthly : b.planBalance.inactive}</span>}
          value={n(summary.buckets.plan)}
          note={plan.active ? fill(b.planBalance.active, { date: periodEnd }) : b.planBalance.idle}
        />
        <BalanceCard label={b.packBalance.label} tag={<Icon name="layers" className="size-4 text-muted" />} value={n(summary.buckets.pack)} note={b.packBalance.note} />
        {!summary.official && (
          <BalanceCard label={b.earnedBalance.label} tag={<Icon name="sparkle" className="size-4" />} value={n(summary.buckets.earned)} note={b.earnedBalance.note} dark />
        )}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <section className={`card flex flex-col p-5 md:p-6 ${plan.active ? 'border-blue ring-1 ring-blue/40' : ''}`}>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[17px] font-bold">{b.plan.title}</h3>
            <span className={`tag ${plan.active ? 'border-[#d8e6fb] bg-soft text-blue' : ''}`}>
              {plan.active ? (plan.cancelAtPeriodEnd ? b.plan.cancelling : b.plan.current) : b.plan.start}
            </span>
          </div>
          <p className="mt-4">
            <strong className="text-[28px] font-extrabold">$10</strong>
            <small className="ml-1 text-muted">/ {b.plan.per}</small>
          </p>
          <p className="text-[13px] text-muted">{b.plan.perCycle}</p>
          <Perks items={[b.plan.perk1, b.plan.perk2, b.plan.perk3]} />
          {plan.active && <p className="mt-4 text-[12px] text-muted">{fill(plan.cancelAtPeriodEnd ? b.plan.ends : b.plan.renews, { date: periodEnd })}</p>}
          <div className="mt-auto pt-5">
            {plan.active ? (
              <RenewalControl cancelAtPeriodEnd={plan.cancelAtPeriodEnd} periodEndLabel={periodEnd} />
            ) : (
              <Link href="/checkout?kind=plan" className="btn w-full">
                {b.plan.subscribe}
              </Link>
            )}
          </div>
        </section>
        <section className="card flex flex-col p-5 md:p-6">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[17px] font-bold">{b.pack.title}</h3>
            <span className="tag">{b.pack.tag}</span>
          </div>
          <p className="mt-4">
            <strong className="text-[28px] font-extrabold">$10</strong>
            <small className="ml-1 text-muted">/ {b.pack.per}</small>
          </p>
          <p className="text-[13px] text-muted">{b.pack.perPack}</p>
          <Perks items={[b.pack.perk1, b.pack.perk2, b.pack.perk3]} />
          <div className="mt-auto pt-5">
            {plan.active ? (
              <Link href="/checkout?kind=pack" className="btn-secondary w-full">
                {b.pack.buy}
              </Link>
            ) : (
              <button type="button" className="btn-secondary w-full" disabled>
                <Icon name="lock" />
                {b.pack.locked}
              </button>
            )}
          </div>
        </section>
      </div>
      <p className="flex items-start gap-2.5 rounded-xl border border-[#dfe6f5] bg-wash px-4 py-3 text-[12px] leading-relaxed text-muted">
        <Icon name="info" className="mt-0.5 size-4 flex-none text-blue" />
        {b.info}
      </p>
      <Entries items={entries.items} total={entries.total} page={entries.page} size={entries.size} activity={entries.activity} official={summary.official} />
      <h2 id="payouts" className="mt-4 scroll-mt-28 text-[17px] font-bold">
        {t.payouts.card.heading}
      </h2>
      <PayoutCard userId={userId} />
    </div>
  );
}

function BalanceCard({ label, tag, value, note, dark = false }: { label: string; tag: ReactNode; value: string; note: string; dark?: boolean }) {
  return (
    <div className={`rounded-xl border p-5 ${dark ? 'border-ink bg-ink text-white' : 'border-line bg-white'}`}>
      <p className={`flex items-center justify-between gap-2 text-[12px] ${dark ? 'text-white/70' : 'text-muted'}`}>
        {label}
        {tag}
      </p>
      <p className="mt-3 font-mono text-[28px] leading-none">{value}</p>
      <p className={`mt-2 text-[11px] ${dark ? 'text-white/60' : 'text-muted'}`}>{note}</p>
    </div>
  );
}

function Perks({ items }: { items: string[] }) {
  return (
    <ul className="mt-4 flex flex-col gap-2 text-[12px]">
      {items.map((item) => (
        <li key={item} className="flex items-start gap-2">
          <Icon name="check" className="mt-0.5 size-3.5 flex-none text-green" />
          {item}
        </li>
      ))}
    </ul>
  );
}
