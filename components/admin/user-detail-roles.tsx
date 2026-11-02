/**
 * The console's role pieces (prototype role-pages.js): the five threshold
 * checks, a user's role panel with its direct changes, and the history of
 * applications and role events. Server components; the role changes go
 * through `ReasonAction`.
 */
import Link from 'next/link';
import type { Messages } from '@/i18n';
import type { Locale } from '@/i18n/locale';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { verificationChecks, type RoleMetrics, type UserRole } from '@/lib/domain/roles';
import { ROLE_REASON_MAX } from '@/lib/constants';
import type { RoleEvent, VerificationRow } from '@/lib/services/roles';
import { Icon } from '@/components/ui/icons';
import { RoleBadge, Tag } from '@/components/admin/list-kit';
import { ReasonAction } from '@/components/admin/list-client';

export type VerificationStatus = VerificationRow['status'];

export function VerificationStatusTag({ t, status }: { t: Messages; status: VerificationStatus }) {
  const tone = status === 'approved' ? 'green' : status === 'rejected' ? 'red' : status === 'pending' ? 'orange' : 'grey';
  return <Tag tone={tone}>{t.consoleUsers.verifications.status[status]}</Tag>;
}

export function RequirementChecks({ t, locale, metrics }: { t: Messages; locale: Locale; metrics: RoleMetrics }) {
  const c = t.consoleUsers.checks;
  const n = (value: number) => formatNumber(value, locale);
  return (
    <ul className="divide-y divide-line">
      {verificationChecks(metrics).map((check) => {
        const rate = check.key === 'helpfulRate';
        const value = rate
          ? check.value === null
            ? c.noFeedback
            : fill(c.rate, { rate: Math.round(check.value * 1000) / 10, n: n(metrics.feedbackCount ?? 0) })
          : fill(c.value, { value: n(check.value ?? 0), target: n(check.target) });
        const missing = check.passed
          ? c.met
          : check.missing === null
            ? c.needFeedback
            : fill(c.missing[check.key], { n: rate ? check.missing : n(check.missing) });
        return (
          <li key={check.key} className="flex items-start gap-3 py-2.5">
            <span
              className={`mt-0.5 inline-flex size-6 flex-none items-center justify-center rounded-full ${check.passed ? 'bg-[#effaf6] text-green' : 'bg-wash text-muted'}`}
              aria-hidden="true"
            >
              <Icon name={check.passed ? 'check' : 'clock'} className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <strong className="block text-[13px] font-semibold">{c.titles[check.key]}</strong>
              <span className="text-[12px] text-muted">{value}</span>
            </div>
            <small className={`max-w-[45%] text-right text-[11px] font-semibold ${check.passed ? 'text-green' : 'text-orange'}`}>{missing}</small>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 账号角色 (prototype `adminUser`): the badge, the notes, and 设为官方 /
 * 取消官方 / 撤销认证 (撤销 only for a verified user), each with a 1–500
 * character reason the user reads.
 */
export function RolePanel({
  t,
  locale,
  user,
  footnote = false,
}: {
  t: Messages;
  locale: Locale;
  user: { id: string; name: string; email: string; role: UserRole; roleChangedAt: Date | null };
  footnote?: boolean;
}) {
  const r = t.consoleUsers.detail.roles;
  const endpoint = `/api/admin/users/${user.id}/role`;
  const reason = { min: 1, max: ROLE_REASON_MAX, required: true, label: r.reason };
  const subtitle = `${user.name} · ${user.email}`;
  return (
    <section className="card min-w-0 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-bold">
          {r.title}
          <RoleBadge t={t} role={user.role} showNormal />
        </h2>
        <small className="text-[11px] text-muted">{user.roleChangedAt ? fill(r.changedAt, { time: formatDateTime(user.roleChangedAt, locale) }) : r.defaultRole}</small>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">{r.note}</p>
      {user.role === 'official' && <p className="mt-3 rounded-lg bg-soft px-3 py-2 text-[12px] leading-relaxed text-blue">{r.official}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        {user.role !== 'official' ? (
          <ReasonAction
            endpoint={endpoint}
            method="PUT"
            label={r.makeOfficial}
            icon="globe"
            title={r.makeOfficial}
            subtitle={subtitle}
            body={r.officialImpact}
            confirmLabel={r.confirm}
            reason={reason}
            payload={{ action: 'official' }}
            errors={r.errors}
          />
        ) : (
          <ReasonAction
            endpoint={endpoint}
            method="PUT"
            label={r.cancelOfficial}
            title={r.cancelOfficial}
            subtitle={subtitle}
            body={r.normalImpact}
            confirmLabel={r.confirm}
            reason={reason}
            payload={{ action: 'cancel_official' }}
            errors={r.errors}
            danger
          />
        )}
        {user.role === 'verified' && (
          <ReasonAction
            endpoint={endpoint}
            method="PUT"
            label={r.revoke}
            title={r.revoke}
            subtitle={subtitle}
            body={r.normalImpact}
            confirmLabel={r.confirm}
            reason={reason}
            payload={{ action: 'revoke' }}
            errors={r.errors}
            danger
          />
        )}
        <Link href={`/admin/verifications?status=all&q=${encodeURIComponent(user.email)}`} className="btn-secondary btn-sm">
          {r.viewRequests}
        </Link>
      </div>
      {footnote && <p className="mt-3 text-[11px] text-muted">{r.footnote}</p>}
    </section>
  );
}

/** 申请与角色记录: applications and role events, newest first. */
export function RoleHistory({
  t,
  locale,
  requests,
  events,
  back,
}: {
  t: Messages;
  locale: Locale;
  requests: VerificationRow[];
  events: RoleEvent[];
  /** The encoded URL of the page, for the application links' `from`. */
  back: string;
}) {
  const r = t.consoleUsers.detail.roles;
  const time = (value: Date) => formatDateTime(value, locale);
  const items = [
    ...requests.map((request) => ({ at: request.createdAt, kind: 'request' as const, request })),
    ...events.map((event) => ({ at: event.at, kind: 'event' as const, event })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
  return (
    <section className="card min-w-0 p-5">
      <h2 className="text-[15px] font-bold">{r.history}</h2>
      {items.length === 0 ? (
        <p className="mt-3 text-[13px] text-muted">{r.noHistory}</p>
      ) : (
        <ol className="mt-2 divide-y divide-line">
          {items.map((item) =>
            item.kind === 'request' ? (
              <li key={`request-${item.request.id}`} className="min-w-0 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-[13px]">{r.request}</strong>
                  <VerificationStatusTag t={t} status={item.request.status} />
                </div>
                <small className="mt-0.5 block text-[11px] text-muted">
                  {fill(r.submitted, { time: time(item.request.createdAt) })}
                  {item.request.decidedAt && ` · ${fill(r.reviewed, { time: time(item.request.decidedAt) })}`}
                </small>
                <p className="mt-2 line-clamp-3 text-[13px] break-words whitespace-pre-line">{item.request.statement}</p>
                {item.request.closedByRoleChange && <p className="mt-1.5 text-[12px] text-muted">{t.consoleUsers.verifications.closedByRole}</p>}
                {item.request.rejectedReason && (
                  <div className="mt-2 rounded-lg bg-wash px-3 py-2 text-[12px]">
                    <strong className="block text-[11px] text-muted">{r.reviewNote}</strong>
                    <p className="break-words whitespace-pre-line">{item.request.rejectedReason}</p>
                  </div>
                )}
                <Link href={`/admin/verifications/${item.request.id}?from=${back}`} className="text-link mt-2 text-[12px]">
                  {r.viewRequest}
                </Link>
              </li>
            ) : (
              <li key={`event-${item.event.id}`} className="min-w-0 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-[13px]">
                    {fill(r.change, { from: t.console.roles[item.event.from], to: t.console.roles[item.event.to] })}
                  </strong>
                  <Tag>{(t.console.actions as Record<string, string>)[item.event.action] ?? item.event.action}</Tag>
                </div>
                <small className="mt-0.5 block text-[11px] text-muted">
                  {time(item.event.at)}
                  {item.event.administrator && ` · ${fill(r.by, { admin: item.event.administrator })}`}
                </small>
                <p className="mt-2 text-[13px] break-words whitespace-pre-line">{item.event.reason || '—'}</p>
              </li>
            ),
          )}
        </ol>
      )}
    </section>
  );
}
