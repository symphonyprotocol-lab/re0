import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { ReactNode } from 'react';
import { EARNED_MATURITY_DAYS, PAYOUT_MIN_CREDITS } from '@/lib/constants';
import { formatCentsUsd, formatCreditsUsd as usd } from '@/lib/domain/payouts';
import { kycOverview } from '@/lib/services/kyc';
import { payoutOverview, type PayoutRow } from '@/lib/services/payouts';
import { serverMessages } from '@/i18n/server';
import { fill, formatDate, formatDateTime, formatNumber } from '@/i18n/format';
import { PaypalButton, RequestPayoutButton } from '@/components/payouts/payout-dialogs';
import { OfficialNotice } from '@/components/settings/role-tab';
import { I } from '@/components/settings/icon';


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
  if (overview.official) return <OfficialNotice t={t} />;
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
    <div className="billing-payout">
      <section className="card settings-card earnings-card">
        <div className="between">
          <h2>{c.title}</h2>
          <span className="tag blue">{c.tag}</span>
        </div>
        <p className="muted">{fill(c.lede, { min: n(PAYOUT_MIN_CREDITS), usd: usd(PAYOUT_MIN_CREDITS) })}</p>

        <Step done={verified} index="1" title={c.identity} body={detail}>
          {verified ? (
            <span className="tag green">
              <I name="check" />
              {c.verified}
            </span>
          ) : (
            <Link href="/settings/identity" className="btn secondary sm">
              {kyc === 'pending' ? c.view : kyc === 'rejected' || kyc === 'reset' ? c.resubmit : c.submit}
            </Link>
          )}
        </Step>
        {feedback && (
          <div className="kyc-feedback" role="status">
            <strong>{c.feedback}</strong>
            <p>{feedback}</p>
          </div>
        )}
        {record && (kyc === 'pending' || kyc === 'verified') && (
          <div className="kyc-record-meta">
            {[record.legalName, record.country, record.documentKind ? t.payouts.kyc.kinds[record.documentKind] : null].filter(Boolean).join(' · ')}
            <br />
            {verified && record.decidedAt
              ? fill(c.metaReviewed, { submitted: formatDate(record.createdAt, locale), reviewed: formatDate(record.decidedAt, locale) })
              : fill(c.meta, { submitted: formatDate(record.createdAt, locale) })}
          </div>
        )}

        <Step done={Boolean(overview.paypalEmail) && verified} index="2" title={c.paypal} body={overview.paypalEmail ?? c.paypalHint}>
          <PaypalButton email={overview.paypalEmail} disabled={!verified} />
        </Step>

        <div className="kyc-privacy">
          <I name="shield" />
          <span>{c.privacy}</span>
        </div>
        <div className="rule" />
        <div className="between">
          <span className="small muted">
            {c.available}
            <br />
            <strong className="mono earnings-amount">{usd(overview.withdrawable)}</strong>
          </span>
          {verified ? (
            <RequestPayoutButton withdrawable={overview.withdrawable} email={overview.paypalEmail} enabled={stage === 'eligible'} />
          ) : kyc === 'pending' ? (
            <button type="button" className="btn" disabled>
              {c.pending}
            </button>
          ) : (
            <Link href="/settings/identity" className="btn">
              {c.verify}
            </Link>
          )}
        </div>
        {(overview.maturing > 0 || overview.locked > 0) && (
          <p className="tiny muted mt16">
            {overview.maturing > 0 && overview.nextMaturesAt && (
              <>
                {fill(c.maturing, { amount: usd(overview.maturing), days: String(EARNED_MATURITY_DAYS), next: usd(overview.nextMaturing), date: formatDate(overview.nextMaturesAt, locale) })}
                {overview.locked > 0 && <br />}
              </>
            )}
            {overview.locked > 0 && fill(c.locked, { amount: usd(overview.locked) })}
          </p>
        )}
        {blocked && verified && <p className="kyc-feedback small">{blocked}</p>}
        {open && <Progress t={t} locale={locale} payout={open} />}
        <p className="tiny muted mt16">{c.flow}</p>
      </section>

      <section className="card settings-card earnings-card">
        <h2>{c.historyTitle}</h2>
        {overview.history.length === 0 ? (
          <div className="empty payout-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 7V4H5a3 3 0 0 0 0 6h16v10H5a3 3 0 0 1-3-3V7" />
              <path d="M21 10h-6v6h6M17 13h.01" />
            </svg>
            <h3>{c.historyEmpty}</h3>
            <p>{c.historyEmptyBody}</p>
          </div>
        ) : (
          overview.history.map((payout) => (
            <div key={payout.id} className="settings-row">
              <div className="min-w-0">
                <h3 className="mono">{usd(payout.credits)}</h3>
                <p title={payout.paypalEmail}>{payout.paypalEmail}</p>
                <p>{fill(c.requestedAt, { time: formatDateTime(payout.createdAt, locale) })}</p>
                {(payout.status === 'rejected' ? payout.reviewNote : payout.failureReason) && <p>{payout.status === 'rejected' ? payout.reviewNote : payout.failureReason}</p>}
                {payout.status === 'paid' && payout.paidCents !== null && (
                  <p>
                    {fill(c.net, { paid: formatCentsUsd(payout.paidCents), fee: usd(payout.feeCredits ?? 0) })}
                    <br />
                    {fill(c.transfer, { id: payout.transferId ?? '—' })}
                  </p>
                )}
              </div>
              <PayoutStateTag status={payout.status} label={c.status[payout.status]} />
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function Step({ done, index, title, body, children }: { done: boolean; index: string; title: string; body: string; children: ReactNode }) {
  return (
    <div className="kyc-step">
      <span className={`step-circle ${done ? 'done' : ''}`}>{done ? <I name="check" /> : index}</span>
      <div className="s-grow">
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
      {children}
    </div>
  );
}

/** The payout in progress in three steps (8.2: the prototype shows none). */
function Progress({ t, locale, payout }: { t: Awaited<ReturnType<typeof serverMessages>>['t']; locale: 'zh' | 'en'; payout: PayoutRow }) {
  const c = t.payouts.card;
  const current = payout.status === 'pending' ? 1 : 2;
  return (
    <div className="payout-progress">
      <p className="between">
        <strong>{c.progress}</strong>
        <span className="mono">
          {usd(payout.credits)} · {formatDate(payout.createdAt, locale)}
        </span>
      </p>
      <ol>
        {c.steps.map((step, index) => (
          <li key={step.title} className={index < current ? 'done' : index === current ? 'current' : ''}>
            <strong>
              {index < current ? <I name="check" /> : <span className="mono">{index + 1}</span>}
              {step.title}
            </strong>
            <span>{step.body}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function PayoutStateTag({ status, label }: { status: PayoutRow['status']; label: string }) {
  const tone = status === 'paid' ? 'green' : status === 'failed' || status === 'rejected' ? 'red' : 'orange';
  return <span className={`tag ${tone}`}>{label}</span>;
}
