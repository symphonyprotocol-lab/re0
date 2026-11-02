import Link from 'next/link';
import type { ReactNode } from 'react';
import { PAYOUT_MIN_CREDITS } from '@/lib/constants';
import { formatCentsUsd, formatCreditsUsd as usd } from '@/lib/domain/payouts';
import { kycOverview } from '@/lib/services/kyc';
import { payoutOverview, type PayoutRow } from '@/lib/services/payouts';
import { serverMessages } from '@/i18n/server';
import { fill, formatDate, formatDateTime, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { PaypalButton, RequestPayoutButton } from '@/components/payouts/payout-dialogs';


/**
 * The billing tab's 收款卡 (prototype manual-kyc.js `userCard`): identity
 * (the gate), the PayPal address (after verification; a change starts seven
 * days without payouts), the withdrawable earnings and the request, the
 * payout in progress in three steps, and the history beside it. Official
 * accounts see their notice instead.
 */
export async function PayoutCard({ userId }: { userId: string }) {
  const { t, locale } = await serverMessages();
  const c = t.payouts.card;
  const [overview, identity] = await Promise.all([payoutOverview(userId), kycOverview(userId)]);
  const n = (value: number) => formatNumber(value, locale);
  if (overview.official) {
    return (
      <section className="card bg-[#fbfaff] p-5 md:p-6">
        <h2 className="flex items-center gap-2 text-[15px] font-bold">
          <Icon name="globe" className="size-4 text-[#7255bd]" />
          {t.roles.official.title}
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">{t.roles.official.body}</p>
      </section>
    );
  }
  const { stage, kyc, open } = overview;
  const record = identity.record;
  const verified = kyc === 'verified';
  const detail = verified ? c.identityVerified : kyc === 'pending' ? c.identityPending : kyc === 'rejected' ? c.identityRejected : kyc === 'reset' ? c.identityReset : c.identityNone;
  const blocked =
    stage === 'review' || stage === 'payment'
      ? c.blocked.payout_open
      : stage === 'hold' && overview.paypalHoldUntil
        ? fill(c.blocked.hold, { date: formatDate(overview.paypalHoldUntil, locale) })
        : stage === 'paypal'
          ? c.blocked.paypal
          : stage === 'threshold'
            ? fill(c.blocked.threshold, { min: n(PAYOUT_MIN_CREDITS), usd: usd(PAYOUT_MIN_CREDITS) })
            : '';
  const feedback = record?.reason && (kyc === 'rejected' || kyc === 'reset') ? record.reason : null;

  return (
    <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <section className="card min-w-0 p-5 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[17px] font-bold">{c.title}</h2>
          <span className="tag border-[#d8e6fb] bg-soft text-blue">{c.tag}</span>
        </div>
        <p className="mt-1 text-[12px] text-muted">{fill(c.lede, { min: n(PAYOUT_MIN_CREDITS), usd: usd(PAYOUT_MIN_CREDITS) })}</p>

        <Step done={verified} index="1" title={c.identity} body={detail}>
          {verified ? (
            <span className="tag flex-none border-[#cde8df] bg-[#effaf6] text-green">
              <Icon name="check" className="size-3" />
              {c.verified}
            </span>
          ) : (
            <Link href="/settings/identity" className="btn-secondary btn-sm flex-none">
              {kyc === 'pending' ? c.view : kyc === 'rejected' || kyc === 'reset' ? c.resubmit : c.submit}
            </Link>
          )}
        </Step>
        {feedback && (
          <div role="status" className="mt-3 ml-8 rounded-lg border border-[#f0dcc2] bg-[#fff7ec] px-3 py-2.5 text-[12px]">
            <strong className="block text-orange">{c.feedback}</strong>
            <p className="mt-1 break-words whitespace-pre-line">{feedback}</p>
          </div>
        )}
        {record && (kyc === 'pending' || kyc === 'verified') && (
          <p className="mt-2 ml-8 text-[11px] leading-relaxed break-words text-muted">
            {[record.legalName, record.country, record.documentKind ? t.payouts.kyc.kinds[record.documentKind] : null].filter(Boolean).join(' · ')}
            <br />
            {verified && record.decidedAt
              ? fill(c.metaReviewed, { submitted: formatDate(record.createdAt, locale), reviewed: formatDate(record.decidedAt, locale) })
              : fill(c.meta, { submitted: formatDate(record.createdAt, locale) })}
          </p>
        )}

        <Step done={Boolean(overview.paypalEmail) && verified} index="2" title={c.paypal} body={overview.paypalEmail ?? c.paypalHint}>
          <PaypalButton email={overview.paypalEmail} disabled={!verified} />
        </Step>

        <p className="mt-5 flex items-start gap-2 rounded-lg bg-wash px-3 py-2.5 text-[11px] leading-relaxed text-muted">
          <Icon name="shield" className="mt-0.5 size-3.5 flex-none text-blue" />
          {c.privacy}
        </p>
        <div className="my-5 border-t border-line" />
        <div className="flex flex-wrap items-end justify-between gap-3">
          <span className="text-[12px] text-muted">
            {c.available}
            <strong className="mt-1 block font-mono text-[24px] leading-none text-ink">{usd(overview.withdrawable)}</strong>
            <small className="mt-1 block font-mono text-[11px]">{n(overview.withdrawable)} credits</small>
          </span>
          {verified ? (
            <RequestPayoutButton withdrawable={overview.withdrawable} email={overview.paypalEmail} enabled={stage === 'eligible'} />
          ) : kyc === 'pending' ? (
            <button type="button" className="btn flex-none" disabled>
              {c.pending}
            </button>
          ) : (
            <Link href="/settings/identity" className="btn flex-none">
              {c.verify}
            </Link>
          )}
        </div>
        {blocked && verified && <p className="mt-3 rounded-lg bg-[#fff7ec] px-3 py-2 text-[12px] text-orange">{blocked}</p>}
        {open && <Progress t={t} locale={locale} payout={open} />}
        <p className="mt-4 text-[11px] leading-relaxed text-muted">{c.flow}</p>
      </section>

      <section className="card min-w-0 p-5 md:p-6">
        <h2 className="text-[17px] font-bold">{c.historyTitle}</h2>
        {overview.history.length === 0 ? (
          <div className="flex flex-col items-center px-3 py-10 text-center">
            <Icon name="sparkle" className="size-6 text-muted" />
            <h3 className="mt-3 text-[14px] font-bold">{c.historyEmpty}</h3>
            <p className="mt-1 text-[12px] text-muted">{c.historyEmptyBody}</p>
          </div>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {overview.history.map((payout) => (
              <li key={payout.id} className="flex min-w-0 items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <h3 className="font-mono text-[14px] font-bold">{usd(payout.credits)}</h3>
                  <p className="truncate text-[12px] text-muted" title={payout.paypalEmail}>
                    {payout.paypalEmail}
                  </p>
                  <p className="text-[11px] text-muted">{fill(c.requestedAt, { time: formatDateTime(payout.createdAt, locale) })}</p>
                  {payout.status === 'paid' && payout.paidCents !== null && (
                    <p className="mt-1 text-[11px] break-all text-muted">
                      {fill(c.net, { paid: formatCentsUsd(payout.paidCents), fee: usd(payout.feeCredits ?? 0) })}
                      <br />
                      {fill(c.transfer, { id: payout.transferId ?? '—' })}
                    </p>
                  )}
                  {(payout.status === 'rejected' ? payout.reviewNote : payout.failureReason) && (
                    <p className="mt-1 text-[11px] break-words text-muted">{payout.status === 'rejected' ? payout.reviewNote : payout.failureReason}</p>
                  )}
                </div>
                <PayoutStateTag status={payout.status} label={c.status[payout.status]} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Step({ done, index, title, body, children }: { done: boolean; index: string; title: string; body: string; children: ReactNode }) {
  return (
    <div className="mt-5 flex min-w-0 items-start gap-3">
      <span
        className={`mt-0.5 inline-flex size-5 flex-none items-center justify-center rounded-full border font-mono text-[10px] ${done ? 'border-[#d1e9de] bg-[#eaf5ef] text-green' : 'border-line text-muted'}`}
      >
        {done ? <Icon name="check" className="size-3" /> : index}
      </span>
      <div className="min-w-0 flex-1">
        <strong className="block text-[13px]">{title}</strong>
        <p className="mt-0.5 text-[12px] break-words text-muted">{body}</p>
      </div>
      {children}
    </div>
  );
}

function Progress({ t, locale, payout }: { t: Awaited<ReturnType<typeof serverMessages>>['t']; locale: 'zh' | 'en'; payout: PayoutRow }) {
  const c = t.payouts.card;
  const current = payout.status === 'pending' ? 1 : 2;
  return (
    <div className="mt-4 rounded-xl border border-line p-4">
      <p className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
        <strong>{c.progress}</strong>
        <span className="font-mono">
          {usd(payout.credits)} · {formatDate(payout.createdAt, locale)}
        </span>
      </p>
      <ol className="mt-3 grid gap-2 sm:grid-cols-3">
        {c.steps.map((step, index) => (
          <li key={step.title} className={`rounded-lg px-3 py-2 text-[11px] ${index < current ? 'bg-[#eaf5ef]' : index === current ? 'bg-soft' : 'bg-wash'}`}>
            <strong className={`flex items-center gap-1 ${index < current ? 'text-green' : index === current ? 'text-blue' : 'text-muted'}`}>
              {index < current ? <Icon name="check" className="size-3" /> : <span className="font-mono">{index + 1}</span>}
              {step.title}
            </strong>
            <span className="mt-0.5 block text-muted">{step.body}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function PayoutStateTag({ status, label }: { status: PayoutRow['status']; label: string }) {
  const tone =
    status === 'paid'
      ? 'border-[#cde8df] bg-[#effaf6] text-green'
      : status === 'failed' || status === 'rejected'
        ? 'border-[#f1d4d4] bg-[#fff3f3] text-red'
        : 'border-[#f0dcc2] bg-[#fff7ec] text-orange';
  return <span className={`tag flex-none whitespace-nowrap ${tone}`}>{label}</span>;
}
