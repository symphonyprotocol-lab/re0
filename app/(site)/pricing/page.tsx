import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { WELCOME_CREDITS } from '@/lib/constants';
import { currentUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { hasActivePlan } from '@/lib/services/billing';
import { serverMessages } from '@/i18n/server';
import { formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { Estimator } from '@/components/site/estimator';
import { Faq } from '@/components/site/faq';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.site.pricing.title };
}

/**
 * `/pricing` (prototype `#/pricing`): the free trial, Plan and Pack; what
 * credits are spent on; the estimator. A signed-in user without an active
 * Plan sees the Pack button disabled with the reason (2.3).
 */
export default async function PricingPage() {
  const [user, { t, locale }] = await Promise.all([currentUser(), serverMessages()]);
  const p = t.site.pricing;
  const planActive = user ? await hasActivePlan(db(), user.id) : false;
  const packLocked = Boolean(user) && !planActive;
  const costs = (['ask', 'process', 'audio', 'script', 'export'] as const).map((key) => p.costs[key]);
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-14 sm:px-6">
      <div className="text-center">
        <p className="eyebrow">SMALL PRICE. A WORLD OF KNOWLEDGE.</p>
        <h1 className="mt-3 text-[34px] leading-tight font-extrabold sm:text-[48px]">
          {p.headline}
          <em className="text-blue not-italic">{p.headlineEm}</em>
        </h1>
        <p className="mx-auto mt-4 max-w-[560px] text-[14px] text-muted">{p.lede}</p>
        <span className="mt-5 inline-block rounded-full border border-line bg-wash px-3 py-1 font-mono text-[11px] tracking-[0.12em]">1 CREDIT = $0.0001</span>
      </div>

      <div className="mt-12 grid gap-5 lg:grid-cols-3">
        <PlanCard
          eyebrow={p.free.eyebrow}
          title={p.free.title}
          price="$0"
          grant={formatNumber(WELCOME_CREDITS, locale)}
          note={p.free.note}
          perks={[p.free.perk1, p.free.perk2, p.free.perk3]}
          action={
            <Link href={user ? '/dashboard' : '/login'} className="btn-secondary w-full">
              {p.free.cta}
            </Link>
          }
        />
        <PlanCard
          recommended={p.plan.ribbon}
          eyebrow={p.plan.eyebrow}
          title="Plan"
          price="$10"
          per={p.plan.per}
          grant="100,000"
          grantPer={p.plan.cycle}
          note={p.plan.note}
          perks={[p.plan.perk1, p.plan.perk2, p.plan.perk3]}
          action={
            planActive ? (
              <Link href="/settings?tab=billing" className="btn w-full">
                {p.plan.manage}
              </Link>
            ) : (
              <Link href="/checkout?kind=plan" className="btn w-full">
                {p.plan.cta}
                <Icon name="arrow" />
              </Link>
            )
          }
        />
        <PlanCard
          eyebrow={p.pack.eyebrow}
          title="Pack"
          price="$10"
          per={p.pack.per}
          grant="100,000"
          note={p.pack.note}
          perks={[p.pack.perk1, p.pack.perk2, p.pack.perk3]}
          action={
            packLocked ? (
              <>
                <button type="button" className="btn-secondary w-full" disabled aria-describedby="pack-locked">
                  <Icon name="lock" />
                  {p.pack.locked}
                </button>
                <p id="pack-locked" className="mt-2 text-[11px] leading-relaxed text-muted">
                  {p.pack.lockedReason}
                </p>
              </>
            ) : (
              <Link href="/checkout?kind=pack" className="btn-secondary w-full">
                {p.pack.cta}
              </Link>
            )
          }
        />
      </div>

      <section className="card mt-12 p-6 md:p-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="eyebrow">{p.costs.eyebrow}</p>
            <h2 className="mt-2 text-[20px] font-bold">{p.costs.title}</h2>
          </div>
          <span className="tag border-[#d8e6fb] bg-soft text-blue">{p.costs.tag}</span>
        </div>
        <table className="mt-6 hidden w-full text-left text-[13px] md:table">
          <thead className="text-[12px] text-muted">
            <tr className="border-b border-line">
              <th className="py-2.5 font-semibold">{p.costs.activity}</th>
              <th className="py-2.5 font-semibold">{p.costs.cost}</th>
              <th className="py-2.5 font-semibold">{p.costs.details}</th>
            </tr>
          </thead>
          <tbody>
            {costs.map((row) => (
              <tr key={row.activity} className="border-b border-line last:border-0">
                <td className="py-3 font-semibold">{row.activity}</td>
                <td className="py-3 font-mono text-[12px]">{row.cost}</td>
                <td className="py-3 text-muted">{row.details}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="mt-5 flex flex-col divide-y divide-line md:hidden">
          {costs.map((row) => (
            <li key={row.activity} className="py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <strong className="text-[13px]">{row.activity}</strong>
                <span className="font-mono text-[12px]">{row.cost}</span>
              </div>
              <p className="mt-1 text-[12px] text-muted">{row.details}</p>
            </li>
          ))}
        </ul>
      </section>

      <div className="mt-6">
        <Estimator />
      </div>

      <section className="mt-16 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div>
          <p className="eyebrow">NO SMALL PRINT, JUST CLARITY</p>
          <h2 className="mt-3 text-[28px] leading-tight font-extrabold">
            {p.faqTitle1}
            <br />
            {p.faqTitle2}
          </h2>
        </div>
        <Faq t={t} from={2} />
      </section>
    </div>
  );
}

function PlanCard({
  recommended,
  eyebrow,
  title,
  price,
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
  price: string;
  per?: string;
  grant: string;
  grantPer?: string;
  note: string;
  perks: string[];
  action: ReactNode;
}) {
  return (
    <article className={`card relative flex flex-col p-6 ${recommended ? 'border-blue shadow-[0_18px_50px_-30px_rgba(18,126,227,0.6)] ring-1 ring-blue' : ''}`}>
      {recommended && <span className="absolute -top-3 left-6 rounded-full bg-blue px-3 py-1 text-[10px] font-semibold tracking-[0.12em] text-white">{recommended}</span>}
      <span className="eyebrow">{eyebrow}</span>
      <h2 className="mt-2 text-[22px] font-extrabold">{title}</h2>
      <p className="mt-5">
        <strong className="text-[40px] font-extrabold">{price}</strong>
        {per && <small className="ml-1 text-[13px] text-muted">/ {per}</small>}
      </p>
      <p className="font-mono text-[17px] text-blue">
        {grant} <span className="text-[12px] text-muted">credits{grantPer ? ` / ${grantPer}` : ''}</span>
      </p>
      <p className="mt-2 text-[13px] text-muted">{note}</p>
      <div className="mt-6">{action}</div>
      <ul className="mt-6 flex flex-col gap-2.5 border-t border-line pt-5 text-[13px]">
        {perks.map((perk) => (
          <li key={perk} className="flex items-start gap-2">
            <Icon name="check" className="mt-0.5 size-4 flex-none text-green" />
            {perk}
          </li>
        ))}
      </ul>
    </article>
  );
}
