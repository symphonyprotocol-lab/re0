/**
 * The console's role pieces in the prototype's markup (role-pages.js
 * `adminUser`, `historyPanel`, `checks`): a user's role panel with its direct
 * changes, the history of applications and role events, and the five
 * verification checks. Server components; the role changes go through
 * `ReasonAction`.
 */
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { Messages } from '@/i18n';
import type { Locale } from '@/i18n/locale';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { verificationChecks, type RoleMetrics, type UserRole } from '@/lib/domain/roles';
import { ROLE_REASON_MAX } from '@/lib/constants';
import type { RoleEvent, VerificationRow } from '@/lib/services/roles';
import { CI } from '@/components/admin/console-icon';
import { RoleBadge, Tag } from '@/components/admin/list-kit';
import { ReasonAction } from '@/components/admin/list-client';
import { imageUrl } from '@/components/ui/ree-avatar';
import '@/components/admin/console-users.css';

export type VerificationStatus = VerificationRow['status'];

/** A request's state (role-pages.js `status`): a tag without the leading dot. */
export function VerificationStatusTag({ t, status }: { t: Messages; status: VerificationStatus }) {
  const tone = status === 'approved' ? 'green' : status === 'rejected' ? 'red' : status === 'pending' ? 'orange' : 'grey';
  return (
    <Tag tone={tone} dot={false}>
      {t.consoleUsers.verifications.status[status]}
    </Tag>
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
  const change = (label: string, action: string, impact: string) => (
    <ReasonAction
      endpoint={endpoint}
      method="PUT"
      label={label}
      title={label}
      subtitle={user.name}
      confirmLabel={r.confirm}
      reason={reason}
      payload={{ action }}
      errors={r.errors}
    >
      <p className="role-change-impact">{impact}</p>
    </ReasonAction>
  );
  return (
    <section className="card role-panel">
      <div className="between">
        <h2>
          {r.title} <RoleBadge t={t} role={user.role} showNormal />
        </h2>
        <small>{user.roleChangedAt ? formatDateTime(user.roleChangedAt, locale) : r.defaultRole}</small>
      </div>
      <p>{r.note}</p>
      {user.role === 'official' && <p className="role-state-note">{r.official}</p>}
      <div className="role-actions">
        {user.role !== 'official' ? change(r.makeOfficial, 'official', r.officialImpact) : change(r.cancelOfficial, 'cancel_official', r.normalImpact)}
        {user.role === 'verified' && change(r.revoke, 'revoke', r.normalImpact)}
        <Link href={`/admin/verifications?status=all&q=${encodeURIComponent(user.email)}`} className="btn secondary sm">
          {r.viewRequests}
        </Link>
      </div>
      {footnote && <p className="role-footnote">{r.footnote}</p>}
    </section>
  );
}

/** 申请与角色记录 (prototype `historyPanel`): applications and role events, newest first. */
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
    <section className="card role-panel">
      <h2>{r.history}</h2>
      {items.length === 0 && <p className="muted">{r.noHistory}</p>}
      {items.map((item) =>
        item.kind === 'request' ? (
          <article key={`request-${item.request.id}`} className="role-history-entry">
            <div className="between">
              <strong>{r.request}</strong>
              <VerificationStatusTag t={t} status={item.request.status} />
            </div>
            <small>
              {time(item.request.createdAt)}
              {item.request.decidedAt && ` · ${fill(r.reviewed, { time: time(item.request.decidedAt) })}`}
            </small>
            <p>{item.request.statement}</p>
            {item.request.closedByRoleChange && <p>{t.consoleUsers.verifications.closedByRole}</p>}
            {item.request.rejectedReason && (
              <div className="role-feedback">
                <strong>{r.reviewNote}</strong>
                <p>{item.request.rejectedReason}</p>
              </div>
            )}
            <Link href={`/admin/verifications/${item.request.id}?from=${back}`} className="text-link">
              {r.viewRequest}
            </Link>
          </article>
        ) : (
          <article key={`event-${item.event.id}`} className="role-history-entry">
            <div className="between">
              <strong>{fill(r.change, { from: t.console.roles[item.event.from], to: t.console.roles[item.event.to] })}</strong>
              <small>{time(item.event.at)}</small>
            </div>
            <p>{item.event.reason || '—'}</p>
            <small>{item.event.administrator ?? '—'}</small>
          </article>
        ),
      )}
    </section>
  );
}

/** The five verification checks (prototype `checks`): the figure against its target and what is still missing. */
export function RoleChecks({ t, locale, metrics }: { t: Messages; locale: Locale; metrics: RoleMetrics }) {
  const q = t.roles.requirements;
  const n = (value: number) => formatNumber(value, locale);
  return (
    <div className="role-requirements">
      {verificationChecks(metrics).map((check) => {
        const value =
          check.key === 'helpfulRate'
            ? check.value === null
              ? q.noFeedback
              : fill(q.rate, { rate: Math.round(check.value * 1000) / 10, count: n(metrics.feedbackCount) })
            : fill(q.value, { value: n(check.value ?? 0), target: n(check.target) });
        const missing = check.passed ? q.met : check.missing === null ? q.needFeedback : fill(q.missing[check.key], { n: n(check.missing) });
        return (
          <div key={check.key} className={`role-requirement ${check.passed ? 'met' : ''}`}>
            <span className="role-check" role="img" aria-label={check.passed ? q.metLabel : q.pendingLabel}>
              <CI name={check.passed ? 'check' : 'clock'} />
            </span>
            <div>
              <strong>{q.items[check.key]}</strong>
              <span>{value}</span>
            </div>
            <small>{missing}</small>
          </div>
        );
      })}
    </div>
  );
}

const DOT_COLORS = ['lilac', 'sand', 'sage', 'rose', 'slate'];

/** A Ree's small avatar (prototype dot-avatar.js `renderDotAvatar`): its picture, or the Ree mark on its color. */
export function DotAvatar({ avatar, color }: { avatar: string | null; color: string | null }) {
  const src = imageUrl(avatar);
  return (
    <span className={`dot-avatar ${color && DOT_COLORS.includes(color) ? color : ''} sm`} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src ? <img src={src} alt="" /> : <CI name="dot" />}
    </span>
  );
}
