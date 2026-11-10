import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ADMIN_REASON } from '@/lib/constants';
import { documentValid } from '@/lib/domain/kyc';
import { param } from '@/lib/domain/list';
import { reportingDate } from '@/lib/domain/statistics';
import { kycDetail } from '@/lib/services/kyc';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime } from '@/i18n/format';
import { ReasonAction } from '@/components/admin/list-client';
import { RoleBadge, Tag } from '@/components/admin/list-kit';
import { CI } from '@/components/admin/console-icon';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { KycStatusTag } from '@/components/admin/payout-kit';
import { KycDecision, KycFiles } from '@/components/admin/kyc-review';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.consolePayouts.kycDetail.title };
}

/** The way back: the KYC list (with its filters), a user page, or a payout that linked here. */
function backTo(raw: string): string {
  return /^\/admin\/(kyc|users|payouts|payout-history)(?:[/?]|$)/.test(raw) ? raw : '/admin/kyc';
}

/**
 * `/admin/kyc/[id]` (prototype manual-kyc.js `reviewPage`): the identity
 * details, both images side by side through 60-second signed links (every
 * fetch audited), the submission and review record, and -- on the user's
 * newest pending submission -- the decision. Any user's newest decided
 * record can be sent back for re-verification.
 */
export default async function KycReviewPage({ params, searchParams }: Props) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const query = await searchParams;
  const { t, locale } = await serverMessages();
  const data = await kycDetail(id);
  if (!data) notFound();
  const k = t.consolePayouts.kyc;
  const d = t.consolePayouts.kycDetail;
  const { record, user } = data;
  const from = backTo(param(query, 'from'));
  const self = `/admin/kyc/${id}${from !== '/admin/kyc' ? `?from=${encodeURIComponent(from)}` : ''}`;
  const back = encodeURIComponent(self);
  const time = (value: Date | null) => (value ? formatDateTime(value, locale) : '—');
  const reviewable = data.latest && record.status === 'pending';
  const resettable = data.latest && (record.status === 'verified' || record.status === 'rejected') && user.role !== 'official';
  const expired = record.documentExpires && !documentValid(record.documentExpires, reportingDate());
  const crumb = from.startsWith('/admin/users')
    ? t.console.nav.users
    : from.startsWith('/admin/payout-history')
      ? t.console.nav['payout-history']
      : from.startsWith('/admin/payouts')
        ? t.console.nav.payouts
        : k.title;
  const facts: [string, ReactNode][] = [
    [d.facts.legalName, record.legalName ?? '—'],
    [d.facts.country, record.country ?? '—'],
    [d.facts.kind, record.documentKind ? t.payouts.kyc.kinds[record.documentKind] : '—'],
    [d.facts.last4, record.documentLast4 ? `•••• ${record.documentLast4}` : '—'],
    [
      d.facts.expires,
      <>
        {record.documentExpires ?? '—'} {expired && <Tag tone="red">{d.expired}</Tag>}
      </>,
    ],
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
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: crumb, href: from }, { label: user.name }]} />
      <div className="kyc-review-page">
        <div className="kyc-page-intro">
          <div>
            <h1>{d.title}</h1>
            <p>
              {user.name} · {user.email} <RoleBadge t={t} role={user.role} />
            </p>
          </div>
          <KycStatusTag t={t} status={record.status} />
        </div>
        <section className="card kyc-review-facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </section>

        {record.status !== 'reset' && <KycFiles id={record.id} available={!record.filesDeletedAt && (record.hasDocument || record.hasSelfie)} />}

        <div className="kyc-review-bottom">
          <section className="card kyc-review-history">
            <h2>{d.history}</h2>
            {rows([
              [d.taxForm, record.taxForm ?? '—'],
              [d.declaration, record.taxDeclaredAt ? `${k.declared} · ${time(record.taxDeclaredAt)}` : k.notDeclared],
              [d.submitted, time(record.createdAt)],
              [d.reviewer, data.reviewer ?? '—'],
              [d.reviewed, time(record.decidedAt)],
              [d.filesDue, record.filesDeletedAt ? fill(d.filesDeletedAt, { time: time(record.filesDeletedAt) }) : time(data.filesDueAt)],
            ])}
            <p className="form-hint mt16">{d.retention}</p>
          </section>

          <section className="card kyc-review-history">
            <h2>{reviewable ? d.decision : d.result}</h2>
            {record.reason && <div className="kyc-feedback">{record.reason}</div>}
            {user.role === 'official' && <p className="form-hint">{d.official}</p>}
            {reviewable ? (
              <KycDecision id={record.id} name={record.legalName ? `${user.name} · ${record.legalName}` : user.name} />
            ) : (
              <>
                <p className="muted small">{record.status === 'reset' ? d.resetRow : data.latest ? d.processed : d.historical}</p>
                {resettable && (
                  <ReasonAction
                    endpoint={`/api/admin/kyc/${record.id}/reset`}
                    label={d.reset}
                    className="btn secondary sm mt16"
                    title={d.resetTitle}
                    subtitle={user.name}
                    body={d.resetBody}
                    confirmLabel={d.resetConfirm}
                    reason={{ min: ADMIN_REASON.min, max: ADMIN_REASON.max, required: true, label: d.resetReason }}
                    errors={t.consolePayouts.errors}
                  />
                )}
              </>
            )}
          </section>
        </div>

        <section className="card kyc-review-history mt24">
          <h2>{d.others}</h2>
          {rows(
            data.history.map((row) => [
              <>
                <KycStatusTag t={t} status={row.status} /> {row.id === data.latestId && <Tag tone="blue">{d.current}</Tag>}
              </>,
              row.id === record.id ? (
                `${row.legalName ?? '—'} · ${time(row.createdAt)}`
              ) : (
                <Link className="text-link" href={`/admin/kyc/${row.id}${from !== '/admin/kyc' ? `?from=${encodeURIComponent(from)}` : ''}`}>
                  {row.legalName ?? '—'} · {time(row.createdAt)}
                </Link>
              ),
            ]),
          )}
          <Link href={`/admin/users/${user.id}?tab=kyc&from=${back}`} className="text-link mt16">
            {d.userLink}
            <CI name="arrow" />
          </Link>
        </section>
      </div>
    </ConsolePage>
  );
}
