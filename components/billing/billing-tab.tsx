import Link from 'next/link';
import { LIST_PAGE_SIZES } from '@/lib/constants';
import { parseActivity } from '@/lib/http/billing';
import { billingSummary, listEntries } from '@/lib/services/billing';
import { serverMessages } from '@/i18n/server';
import { fill, formatDate, formatNumber } from '@/i18n/format';
import { ArrivalNotice } from '@/components/billing/arrival';
import { Entries } from '@/components/billing/entries';
import { RenewalControl } from '@/components/billing/renewal';
import { PayoutCard } from '@/components/payouts/payout-card';
import { I } from '@/components/settings/icon';

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
    <div className={`settings-billing ${summary.official ? 'official-billing' : ''}`}>
      {arriving && <ArrivalNotice transactionId={arriving} />}
      <div className="billing-summary">
        <span className="billing-total">
          {b.total}
          <strong>{n(summary.total)}</strong>
          <span>credits</span>
        </span>
      </div>
      {summary.buckets.welcome > 0 && (
        <div className="welcome-credits">
          <span>
            <I name="sparkle" /> {fill(b.welcome, { n: n(summary.buckets.welcome) })}
          </span>
          <span>{b.noExpiry}</span>
        </div>
      )}
      {summary.debt > 0 && (
        <div role="note" className="billing-debt">
          <I name="info" />
          <span>{fill(b.debt, { n: n(summary.debt) })}</span>
        </div>
      )}
      <div className="billing-balance">
        <div className="card balance-card">
          <p className="label">
            {b.planBalance.label}
            <span className="tag blue">{plan.active ? b.planBalance.monthly : b.planBalance.inactive}</span>
          </p>
          <p className="big-number">{n(summary.buckets.plan)}</p>
          <small>{plan.active ? fill(b.planBalance.active, { date: periodEnd }) : b.planBalance.idle}</small>
        </div>
        <div className="card balance-card">
          <p className="label">
            {b.packBalance.label}
            <I name="layers" />
          </p>
          <p className="big-number">{n(summary.buckets.pack)}</p>
          <small>{b.packBalance.note}</small>
        </div>
        {!summary.official && (
          <div className="card balance-card earned">
            <p className="label">
              {b.earnedBalance.label}
              <I name="sparkle" />
            </p>
            <p className="big-number">{n(summary.buckets.earned)}</p>
            <small>{b.earnedBalance.note}</small>
          </div>
        )}
      </div>
      <div className="billing-plans">
        <section className="card plan-card primary">
          <div className="between">
            <h3>{b.plan.title}</h3>
            <span className={`tag ${plan.active ? 'blue' : ''}`}>{plan.active ? (plan.cancelAtPeriodEnd ? b.plan.cancelling : b.plan.current) : b.plan.start}</span>
          </div>
          <p className="plan-price">
            $10<small> / {b.plan.per}</small>
          </p>
          <p>{b.plan.perCycle}</p>
          <Features items={[b.plan.perk1, b.plan.perk2, b.plan.perk3]} />
          {plan.active && <p className="plan-renewal">{fill(plan.cancelAtPeriodEnd ? b.plan.ends : b.plan.renews, { date: periodEnd })}</p>}
          {plan.active ? (
            <RenewalControl cancelAtPeriodEnd={plan.cancelAtPeriodEnd} periodEndLabel={periodEnd} />
          ) : (
            <Link href="/checkout?kind=plan" className="btn">
              {b.plan.subscribe}
            </Link>
          )}
        </section>
        <section className="card plan-card">
          <div className="between">
            <h3>{b.pack.title}</h3>
            <span className="tag">{b.pack.tag}</span>
          </div>
          <p className="plan-price">
            $10<small> / {b.pack.per}</small>
          </p>
          <p>{b.pack.perPack}</p>
          <Features items={[b.pack.perk1, b.pack.perk2, b.pack.perk3]} />
          {plan.active ? (
            <Link href="/checkout?kind=pack" className="btn secondary">
              {b.pack.buy}
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
      <Entries items={entries.items} total={entries.total} page={entries.page} size={entries.size} activity={entries.activity} official={summary.official} />
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
