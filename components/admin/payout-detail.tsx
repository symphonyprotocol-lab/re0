import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { param } from '@/lib/domain/list';
import { payoutDetail } from '@/lib/services/payouts';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { RoleBadge } from '@/components/admin/list-kit';
import { CI } from '@/components/admin/console-icon';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { centsUsd, creditsUsd, KycStatusTag, PayoutStatusTag } from '@/components/admin/payout-kit';
import { PayoutPayment, PayoutReview } from '@/components/admin/payout-forms';
import { PayoutFundingCards } from '@/components/admin/payout-funding';
import type { Administrator } from '@/lib/services/admin';
import { payoutFunding } from '@/lib/services/payout-funding';


const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The way back: the review queue, the history or a user page (with their filters). */
function backTo(raw: string): string {
  return /^\/admin\/(payouts|payout-history|users)(?:[/?]|$)/.test(raw) ? raw : '/admin/payouts';
}

/**
 * `/admin/payouts/[id]` and `/admin/payouts/[id]/payment` (prototype
 * suite.js `payoutDetailPage`): a pending request is reviewed on the first,
 * an approved one is paid or failed on the second (each redirects to the
 * other when the status calls for it), and a finished one is read-only on
 * both. Identity, tax and the PayPal address sit beside it, with the three
 * steps.
 */
export async function PayoutDetailPage({ administrator, id, payment, query }: { administrator: Administrator; id: string; payment: boolean; query: Record<string, string | string[] | undefined> }) {
  if (!UUID.test(id)) notFound();
  const { t, locale } = await serverMessages();
  const data = await payoutDetail(id);
  if (!data) notFound();
  const { payout, user, kyc } = data;
  const from = backTo(param(query, 'from'));
  const suffix = from !== '/admin/payouts' ? `?from=${encodeURIComponent(from)}` : '';
  if (payout.status === 'pending' && payment) redirect(`/admin/payouts/${id}${suffix}`);
  if (payout.status === 'approved' && !payment) redirect(`/admin/payouts/${id}/payment${suffix}`);
  const funding = await payoutFunding(administrator, id, user.id, Number(param(query, 'payers')) || 1);
  const d = t.consolePayouts.payoutDetail;
  const finished = payout.status !== 'pending' && payout.status !== 'approved';
  const time = (value: Date | null) => (value ? formatDateTime(value, locale) : '—');
  const self = encodeURIComponent(`/admin/payouts/${id}${payment ? '/payment' : ''}${suffix}`);
  const crumb = from.startsWith('/admin/payout-history') ? t.console.nav['payout-history'] : from.startsWith('/admin/users') ? t.console.nav.users : t.console.nav.payouts;
  // The step in progress (prototype `payoutProgress`): review while pending, payment once approved, all done after.
  const current = payout.status === 'pending' ? 1 : payout.status === 'approved' ? 2 : 3;
  const steps = [
    { title: d.steps.submitted, body: d.steps.submittedBody },
    { title: d.steps.review, body: payout.status === 'pending' ? d.steps.reviewBody : payout.reviewer ?? '—' },
    { title: d.steps.payment, body: payout.status === 'approved' ? d.steps.paymentBody : finished ? d.steps.done : d.steps.paymentLater },
  ];

  const rows = (items: [ReactNode, ReactNode][]) => (
    <div className="review-checklist">
      {items.map(([label, value], index) => (
        <div key={index}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
  const multiline = (value: string | null) => (value ? <span style={{ whiteSpace: 'pre-line' }}>{value}</span> : '—');

  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: crumb, href: from }, { label: user.name }]} />
      <div className="payout-detail-page">
        <div className="kyc-page-intro">
          <div>
            <h1>{finished ? d.doneTitle : payment ? d.paymentTitle : d.reviewTitle}</h1>
            <p>
              {user.name} · {user.email} <RoleBadge t={t} role={user.role} />
            </p>
          </div>
          <PayoutStatusTag t={t} status={payout.status} />
        </div>
        <section className="card payout-amount-summary">
          <div>
            <span>{d.requested}</span>
            <strong>{creditsUsd(payout.credits)}</strong>
            <small>{formatNumber(payout.credits, locale)} credits</small>
          </div>
          <div>
            <span>{d.requestedAt}</span>
            <strong className="payout-summary-date">{time(payout.createdAt)}</strong>
            <small>{finished ? d.finished : d.held}</small>
          </div>
        </section>
        <div className="payout-detail-grid">
          <div className="payout-detail-main">
            {finished ? (
              <section className="card payout-detail-card">
                <h2>{d.result}</h2>
                {rows([
                  [d.status, <PayoutStatusTag key="status" t={t} status={payout.status} />],
                  [d.reviewer, payout.reviewer ?? '—'],
                  [d.reviewedAt, time(payout.reviewedAt)],
                  [d.reviewNote, multiline(payout.reviewNote)],
                  [d.netPaid, payout.paidCents !== null ? centsUsd(payout.paidCents) : '—'],
                  [d.feeLabel, payout.feeCredits !== null ? creditsUsd(payout.feeCredits) : '—'],
                  [d.transfer, payout.transferId ?? '—'],
                  [d.resolver, `${payout.resolver ?? '—'} / ${time(payout.resolvedAt)}`],
                  [d.failureReason, multiline(payout.failureReason)],
                ])}
                <p className="form-hint mt16">{payout.status === 'paid' ? d.paidNote : d.releasedNote}</p>
              </section>
            ) : payment ? (
              <section className="card payout-detail-card">
                <h2>{d.payment}</h2>
                <div className="info-strip mb16">
                  <CI name="info" />
                  <span>{d.paymentInfo}</span>
                </div>
                <PayoutPayment id={payout.id} credits={payout.credits} payee={{ name: user.name, paypal: payout.paypalEmail }} allowed={data.payable} />
              </section>
            ) : (
              <section className="card payout-detail-card">
                <h2>{d.decision}</h2>
                <div className="info-strip mb16">
                  <CI name="shield" />
                  <span>{d.decisionInfo}</span>
                </div>
                <PayoutReview id={payout.id} credits={payout.credits} payee={{ name: user.name, paypal: payout.paypalEmail }} allowed={data.payable} paymentHref={`/admin/payouts/${payout.id}/payment${suffix}`} />
              </section>
            )}
            <PayoutFundingCards
              t={t}
              locale={locale}
              data={funding}
              back={self}
              pageHref={(page) => `/admin/payouts/${id}${payment ? '/payment' : ''}?${new URLSearchParams({ ...(suffix ? { from } : {}), payers: String(page) })}`}
            />
          </div>
          <aside className="payout-detail-side">
            <section className="card payout-detail-card">
              <div className="between">
                <h2>{d.identity}</h2>
                {kyc && (
                  <Link href={`/admin/kyc/${kyc.id}?from=${self}`} className="text-link">
                    {d.viewKyc}
                  </Link>
                )}
              </div>
              {rows([
                [d.applicant, kyc?.legalName ? `${user.name} · ${kyc.legalName}` : user.name],
                [d.kycStatus, <KycStatusTag key="kyc" t={t} status={payout.kyc} />],
                [d.tax, payout.taxForm ? fill(d.taxValue, { form: payout.taxForm }) : '—'],
                [d.paypal, payout.paypalEmail],
                ...(user.debt > 0 ? [[d.debt, fill(d.debtValue, { credits: formatNumber(user.debt, locale) })] as [ReactNode, ReactNode]] : []),
                ...(user.disabled ? [[d.accountState, d.accountDisabled] as [ReactNode, ReactNode]] : []),
              ])}
              {!finished && user.paypalEmail && user.paypalEmail !== payout.paypalEmail && <p className="form-error mt16">{fill(d.paypalChanged, { email: user.paypalEmail })}</p>}
            </section>
            <section className="card payout-detail-card">
              <h2>{d.progress}</h2>
              <ol className="payout-progress">
                {steps.map((step, index) => (
                  <li key={step.title} className={index < current || finished ? 'done' : index === current ? 'current' : ''}>
                    <strong>{step.title}</strong>
                    <p>{step.body}</p>
                  </li>
                ))}
              </ol>
              <div className="rule" />
              <p className="form-hint">{d.feeRule}</p>
              <Link href="/admin/payout-history" className="text-link mt16">
                {d.viewHistory}
                <CI name="arrow" />
              </Link>
            </section>
          </aside>
        </div>
      </div>
    </ConsolePage>
  );
}
