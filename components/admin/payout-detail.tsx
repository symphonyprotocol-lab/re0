import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { param } from '@/lib/domain/list';
import { payoutDetail } from '@/lib/services/payouts';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { Fields, PageHead, RoleBadge } from '@/components/admin/list-kit';
import { ConsoleTopbar } from '@/components/admin/console-topbar';
import { centsUsd, creditsUsd, KycStatusTag, PayoutStatusTag } from '@/components/admin/payout-kit';
import { PayoutPayment, PayoutReview } from '@/components/admin/payout-forms';
import { Icon } from '@/components/ui/icons';

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
export async function PayoutDetailPage({ id, payment, query }: { id: string; payment: boolean; query: Record<string, string | string[] | undefined> }) {
  if (!UUID.test(id)) notFound();
  const { t, locale } = await serverMessages();
  const data = await payoutDetail(id);
  if (!data) notFound();
  const { payout, user, kyc } = data;
  const from = backTo(param(query, 'from'));
  const suffix = from !== '/admin/payouts' ? `?from=${encodeURIComponent(from)}` : '';
  if (payout.status === 'pending' && payment) redirect(`/admin/payouts/${id}${suffix}`);
  if (payout.status === 'approved' && !payment) redirect(`/admin/payouts/${id}/payment${suffix}`);
  const d = t.consolePayouts.payoutDetail;
  const finished = payout.status !== 'pending' && payout.status !== 'approved';
  const time = (value: Date | null) => (value ? formatDateTime(value, locale) : '—');
  const self = encodeURIComponent(`/admin/payouts/${id}${payment ? '/payment' : ''}${suffix}`);
  const crumb = from.startsWith('/admin/payout-history') ? t.console.nav['payout-history'] : from.startsWith('/admin/users') ? t.console.nav.users : t.console.nav.payouts;
  const current = payout.status === 'pending' ? 1 : payout.status === 'approved' ? 2 : 3;
  const steps = [
    { title: d.steps.submitted, body: d.steps.submittedBody },
    { title: d.steps.review, body: payout.status === 'pending' ? d.steps.reviewBody : payout.reviewer ?? '—' },
    { title: d.steps.payment, body: payout.status === 'approved' ? d.steps.paymentBody : finished ? d.steps.done : d.steps.paymentLater },
  ];

  return (
    <>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: crumb, href: from }, { label: user.name }]} />
      <PageHead
        title={finished ? d.doneTitle : payment ? d.paymentTitle : d.reviewTitle}
        lede={
          <span className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-all">
              {user.name} · {user.email}
            </span>
            <RoleBadge t={t} role={user.role} />
          </span>
        }
        actions={<PayoutStatusTag t={t} status={payout.status} />}
      />
      <section className="card mb-4 grid min-w-0 grid-cols-1 gap-4 p-5 sm:grid-cols-2">
        <div className="min-w-0">
          <span className="text-[11px] text-muted">{d.requested}</span>
          <strong className="mt-1 block font-mono text-[26px] leading-none">{creditsUsd(payout.credits)}</strong>
          <small className="mt-1 block font-mono text-[11px] text-muted">{formatNumber(payout.credits, locale)} credits</small>
        </div>
        <div className="min-w-0">
          <span className="text-[11px] text-muted">{d.requestedAt}</span>
          <strong className="mt-1 block text-[15px]">{time(payout.createdAt)}</strong>
          <small className="mt-1 block text-[11px] text-muted">{finished ? d.finished : d.held}</small>
        </div>
      </section>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          {finished ? (
            <section className="card min-w-0 p-5">
              <h2 className="text-[15px] font-bold">{d.result}</h2>
              <div className="mt-3">
                <Fields
                  items={[
                    [d.status, <PayoutStatusTag key="status" t={t} status={payout.status} />],
                    [d.reviewer, payout.reviewer ?? '—'],
                    [d.reviewedAt, time(payout.reviewedAt)],
                    [d.reviewNote, payout.reviewNote ? <span key="note" className="whitespace-pre-line">{payout.reviewNote}</span> : '—'],
                    [d.netPaid, payout.paidCents !== null ? centsUsd(payout.paidCents) : '—'],
                    [d.feeLabel, payout.feeCredits !== null ? creditsUsd(payout.feeCredits) : '—'],
                    [d.transfer, payout.transferId ? <span key="transfer" className="font-mono break-all">{payout.transferId}</span> : '—'],
                    [d.resolver, `${payout.resolver ?? '—'} / ${time(payout.resolvedAt)}`],
                    [d.failureReason, payout.failureReason ? <span key="failure" className="whitespace-pre-line">{payout.failureReason}</span> : '—'],
                  ]}
                />
              </div>
              <p className="hint mt-4">{payout.status === 'paid' ? d.paidNote : d.releasedNote}</p>
            </section>
          ) : payment ? (
            <section className="card min-w-0 p-5">
              <h2 className="text-[15px] font-bold">{d.payment}</h2>
              <p className="mt-2 mb-4 flex items-start gap-2 rounded-lg bg-wash px-3 py-2.5 text-[12px] leading-relaxed text-muted">
                <Icon name="info" className="mt-0.5 size-4 flex-none text-blue" />
                {d.paymentInfo}
              </p>
              <PayoutPayment id={payout.id} credits={payout.credits} allowed={data.payable} />
            </section>
          ) : (
            <section className="card min-w-0 p-5">
              <h2 className="text-[15px] font-bold">{d.decision}</h2>
              <p className="mt-2 mb-4 flex items-start gap-2 rounded-lg bg-wash px-3 py-2.5 text-[12px] leading-relaxed text-muted">
                <Icon name="shield" className="mt-0.5 size-4 flex-none text-blue" />
                {d.decisionInfo}
              </p>
              <PayoutReview id={payout.id} allowed={data.payable} paymentHref={`/admin/payouts/${payout.id}/payment${suffix}`} />
            </section>
          )}
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <section className="card min-w-0 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[15px] font-bold">{d.identity}</h2>
              {kyc && (
                <Link href={`/admin/kyc/${kyc.id}?from=${self}`} className="text-link text-[12px]">
                  {d.viewKyc}
                </Link>
              )}
            </div>
            <div className="mt-3">
              <Fields
                items={[
                  [d.applicant, kyc?.legalName ? `${user.name} · ${kyc.legalName}` : user.name],
                  [d.kycStatus, <KycStatusTag key="kyc" t={t} status={payout.kyc} />],
                  [d.tax, payout.taxForm ? fill(d.taxValue, { form: payout.taxForm }) : '—'],
                  [d.paypal, <span key="paypal" className="break-all">{payout.paypalEmail}</span>],
                ]}
              />
            </div>
            {!finished && user.paypalEmail && user.paypalEmail !== payout.paypalEmail && (
              <p className="mt-3 rounded-lg bg-[#fff7ec] px-3 py-2 text-[12px] text-orange">{fill(d.paypalChanged, { email: user.paypalEmail })}</p>
            )}
          </section>
          <section className="card min-w-0 p-5">
            <h2 className="text-[15px] font-bold">{d.progress}</h2>
            <ol className="mt-3 flex flex-col gap-3">
              {steps.map((step, index) => {
                const done = index < current;
                const now = index === current && !finished;
                return (
                  <li key={step.title} className="flex items-start gap-3">
                    <span
                      className={`mt-0.5 inline-flex size-5 flex-none items-center justify-center rounded-full border font-mono text-[10px] ${done ? 'border-[#d1e9de] bg-[#eaf5ef] text-green' : now ? 'border-blue text-blue' : 'border-line text-muted'}`}
                    >
                      {done ? <Icon name="check" className="size-3" /> : index + 1}
                    </span>
                    <div className="min-w-0">
                      <strong className="block text-[13px]">{step.title}</strong>
                      <p className="text-[12px] break-words text-muted">{step.body}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
            <div className="my-4 border-t border-line" />
            <p className="hint leading-relaxed">{d.feeRule}</p>
            <Link href="/admin/payout-history" className="text-link mt-3 text-[12px]">
              {d.viewHistory}
              <Icon name="arrow" className="size-3.5" />
            </Link>
          </section>
        </aside>
      </div>
    </>
  );
}
