import type { ReactNode } from 'react';
import { verificationChecks, type RoleMetrics, type UserRole } from '@/lib/domain/roles';
import type { VerificationOverview } from '@/lib/services/roles';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import type { Messages } from '@/i18n';
import type { Locale } from '@/i18n/locale';
import { RoleApplication } from '@/components/settings/role-application';
import { I } from '@/components/settings/icon';

/** The role as the prototype's badge (user-roles.js `badge`): verified with a shield, official with a globe. */
export function RoleTag({ t, role }: { t: Messages; role: UserRole }) {
  return (
    <span className={`role-badge role-${role}`} title={`${t.roles.badgeTitle}${t.roles.roles[role]}`}>
      {role !== 'normal' && <I name={role === 'official' ? 'globe' : 'shield'} />}
      {t.roles.roles[role]}
    </span>
  );
}

/** The official account's notice (prototype role-pages.js `officialNotice`), also shown in place of the payout card. */
export function OfficialNotice({ t }: { t: Messages }) {
  return (
    <section className="card role-panel role-official-notice">
      <I name="globe" />
      <div>
        <h2>{t.roles.official.title}</h2>
        <p>{t.roles.official.body}</p>
      </div>
    </section>
  );
}

/**
 * `/settings?tab=role` (prototype role-pages.js `settings`): the role and
 * when it changed; then by role the official notice, the verified panel, or
 * the threshold beside the application form; then every application and
 * role change. The threshold is computed by the server and checked again
 * when the form is submitted.
 */
export async function RoleTab({ overview }: { overview: VerificationOverview }) {
  const { t, locale } = await serverMessages();
  const r = t.roles;
  const { role, access } = overview;
  const stateNote =
    access.reason === 'pending'
      ? r.apply.state.pending
      : access.reason === 'cooldown'
        ? fill(r.apply.state.cooldown, { date: access.retryAt ? formatDateTime(access.retryAt, locale) : '—' })
        : access.reason === 'disabled'
          ? r.apply.state.disabled
          : access.reason === 'role'
            ? r.apply.state.role
            : access.eligible
              ? r.apply.state.eligible
              : r.apply.state.requirements;
  return (
    <>
      <section className="card role-panel role-account-summary">
        <div>
          <span className="role-eyebrow">{r.summary.eyebrow}</span>
          <h2>
            {r.summary.title} <RoleTag t={t} role={role} />
          </h2>
          <p>{r.summary.note}</p>
        </div>
        <small>{overview.roleChangedAt ? fill(r.summary.updated, { date: formatDateTime(overview.roleChangedAt, locale) }) : r.summary.default}</small>
      </section>

      {role === 'official' ? (
        <OfficialNotice t={t} />
      ) : role === 'verified' ? (
        <section className="card role-panel role-success">
          <h2>
            <I name="shield" />
            {r.verified.title}
          </h2>
          <p>{r.verified.body}</p>
        </section>
      ) : (
        <div className="role-settings-grid">
          <section className="card role-panel">
            <h2>{r.requirements.title}</h2>
            <p>{r.requirements.lede}</p>
            <Requirements t={t} locale={locale} metrics={overview.metrics} />
            <p className="role-footnote">{r.requirements.footnote}</p>
          </section>
          <section className="card role-panel">
            <h2>{r.apply.title}</h2>
            <RoleApplication eligible={access.eligible} note={stateNote} />
          </section>
        </div>
      )}

      <History overview={overview} t={t} locale={locale} />
    </>
  );
}

/** The five checks with "值 / 目标" and what is still missing (prototype role-pages.js `checks`). */
function Requirements({ t, locale, metrics }: { t: Messages; locale: Locale; metrics: RoleMetrics }) {
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
              <I name={check.passed ? 'check' : 'clock'} />
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

function History({ overview, t, locale }: { overview: VerificationOverview; t: Messages; locale: Locale }) {
  const h = t.roles.history;
  const date = (value: Date) => formatDateTime(value, locale);
  const entries: { at: number; node: ReactNode }[] = [
    ...overview.requests.map((request) => ({
      at: request.createdAt.getTime(),
      node: (
        <article key={`request-${request.id}`} className="role-history-entry">
          <div className="between">
            <strong>{h.application}</strong>
            <StatusTag status={request.status} t={t} />
          </div>
          <small>
            {date(request.createdAt)}
            {request.decidedAt && ` · ${fill(h.reviewed, { date: date(request.decidedAt) })}`}
          </small>
          <p className="role-pre">{request.statement}</p>
          {request.links.length > 0 && (
            <ul className="role-history-links" aria-label={h.links}>
              {request.links.map((link) => (
                <li key={link}>
                  <a href={link} target="_blank" rel="noopener noreferrer nofollow" className="text-link">
                    <I name="external" />
                    <span>{link}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          {request.rejectedReason && (
            <div className="role-feedback">
              <strong>{request.status === 'rejected' ? h.rejection : h.note}</strong>
              <p className="role-pre">{request.rejectedReason}</p>
            </div>
          )}
          {request.closedByRoleChange && <small>{h.closedByRole}</small>}
        </article>
      ),
    })),
    ...overview.events.map((event) => ({
      at: event.at.getTime(),
      node: (
        <article key={`event-${event.id}`} className="role-history-entry">
          <div className="between">
            <strong>{fill(h.roleChange, { from: t.roles.roles[event.from], to: t.roles.roles[event.to] })}</strong>
            <small>{date(event.at)}</small>
          </div>
          <p className="role-pre">{event.reason || '—'}</p>
        </article>
      ),
    })),
  ].sort((a, b) => b.at - a.at);
  return (
    <section className="card role-panel">
      <h2>{h.title}</h2>
      {entries.length ? entries.map((entry) => entry.node) : <p className="muted">{h.empty}</p>}
    </section>
  );
}

function StatusTag({ status, t }: { status: 'pending' | 'approved' | 'rejected' | 'closed'; t: Messages }) {
  const tone = status === 'approved' ? 'green' : status === 'rejected' ? 'red' : status === 'pending' ? 'orange' : '';
  return <span className={`tag ${tone}`}>{t.roles.history.status[status]}</span>;
}
