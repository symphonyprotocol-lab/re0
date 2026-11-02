import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ADMIN_REASON } from '@/lib/constants';
import { documentValid } from '@/lib/domain/kyc';
import { param } from '@/lib/domain/list';
import { reportingDate } from '@/lib/domain/statistics';
import { kycDetail } from '@/lib/services/kyc';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime } from '@/i18n/format';
import { ReasonAction } from '@/components/admin/list-client';
import { Fields, PageHead, RoleBadge, Tag } from '@/components/admin/list-kit';
import { KycStatusTag } from '@/components/admin/payout-kit';
import { KycDecision, KycFiles } from '@/components/admin/kyc-review';
import { Icon } from '@/components/ui/icons';

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
  return (
    <>
      <PageHead
        crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: crumb, href: from }, { label: user.name }]}
        title={d.title}
        lede={
          <span className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-all">
              {user.name} · {user.email}
            </span>
            <RoleBadge t={t} role={user.role} />
          </span>
        }
        actions={<KycStatusTag t={t} status={record.status} />}
      />
      <div className="flex min-w-0 flex-col gap-4">
        <section className="card grid min-w-0 grid-cols-1 gap-4 p-5 min-[480px]:grid-cols-2 lg:grid-cols-5">
          {(
            [
              [d.facts.legalName, record.legalName ?? '—'],
              [d.facts.country, record.country ?? '—'],
              [d.facts.kind, record.documentKind ? t.payouts.kyc.kinds[record.documentKind] : '—'],
              [d.facts.last4, record.documentLast4 ? `•••• ${record.documentLast4}` : '—'],
              [
                d.facts.expires,
                <span key="expires" className="flex flex-wrap items-center gap-1.5">
                  {record.documentExpires ?? '—'}
                  {expired && <Tag tone="red">{d.expired}</Tag>}
                </span>,
              ],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="min-w-0">
              <span className="block text-[11px] text-muted">{label}</span>
              <strong className="mt-0.5 block text-[14px] break-words">{value}</strong>
            </div>
          ))}
        </section>

        {record.status !== 'reset' && <KycFiles id={record.id} available={!record.filesDeletedAt && (record.hasDocument || record.hasSelfie)} />}

        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <section className="card min-w-0 p-5">
            <h2 className="text-[15px] font-bold">{d.history}</h2>
            <div className="mt-3">
              <Fields
                items={[
                  [d.taxForm, record.taxForm ?? '—'],
                  [d.declaration, record.taxDeclaredAt ? `${k.declared} · ${time(record.taxDeclaredAt)}` : k.notDeclared],
                  [d.submitted, time(record.createdAt)],
                  [d.reviewer, data.reviewer ?? '—'],
                  [d.reviewed, time(record.decidedAt)],
                  [d.filesDue, record.filesDeletedAt ? fill(d.filesDeletedAt, { time: time(record.filesDeletedAt) }) : time(data.filesDueAt)],
                ]}
              />
            </div>
            <p className="hint mt-4 leading-relaxed">{d.retention}</p>
          </section>

          <section className="card min-w-0 p-5">
            <h2 className="text-[15px] font-bold">{reviewable ? d.decision : d.result}</h2>
            {record.reason && <p className="mt-3 rounded-lg bg-wash px-3 py-2.5 text-[13px] break-words whitespace-pre-line">{record.reason}</p>}
            {user.role === 'official' && <p className="mt-3 rounded-lg bg-[#fbfaff] px-3 py-2 text-[12px] text-muted">{d.official}</p>}
            {reviewable ? (
              <div className="mt-4">
                <KycDecision id={record.id} />
              </div>
            ) : (
              <>
                <p className="mt-3 text-[12px] text-muted">{record.status === 'reset' ? d.resetRow : data.latest ? d.processed : d.historical}</p>
                {resettable && (
                  <div className="mt-4">
                    <ReasonAction
                      endpoint={`/api/admin/kyc/${record.id}/reset`}
                      label={d.reset}
                      icon="refresh"
                      title={d.resetTitle}
                      subtitle={user.name}
                      body={d.resetBody}
                      confirmLabel={d.resetConfirm}
                      reason={{ min: ADMIN_REASON.min, max: ADMIN_REASON.max, required: true, label: d.resetReason }}
                      errors={t.consolePayouts.errors}
                    />
                  </div>
                )}
              </>
            )}
          </section>
        </div>

        <section className="card min-w-0 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
            <h2 className="text-[15px] font-bold">{d.others}</h2>
            <Link href={`/admin/users/${user.id}?tab=kyc&from=${back}`} className="text-link text-[12px]">
              {d.userLink}
              <Icon name="arrow" className="size-3.5" />
            </Link>
          </div>
          <ul className="divide-y divide-line">
            {data.history.map((row) => (
              <li key={row.id}>
                <Link href={`/admin/kyc/${row.id}${from !== '/admin/kyc' ? `?from=${encodeURIComponent(from)}` : ''}`} className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[12px] hover:bg-wash ${row.id === record.id ? 'bg-soft' : ''}`}>
                  <KycStatusTag t={t} status={row.status} />
                  {row.id === data.latestId && <Tag tone="blue">{d.current}</Tag>}
                  <span className="min-w-0 flex-1 truncate">{row.legalName ?? '—'}</span>
                  <span className="whitespace-nowrap text-muted">{time(row.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
