import type { ReactNode } from 'react';
import type { UserRole } from '@/lib/domain/roles';
import type { VerificationOverview } from '@/lib/services/roles';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import type { Messages } from '@/i18n';
import type { Locale } from '@/i18n/locale';
import { Icon } from '@/components/ui/icons';
import { RoleApplication } from '@/components/settings/role-application';
import { RequirementChecks } from '@/components/ui/requirement-checks';

/** The role as a badge: verified green with a shield, official blue with a globe, normal grey. */
export function RoleTag({ t, role }: { t: Messages; role: UserRole }) {
  const tone = role === 'official' ? 'border-[#e7defa] bg-[#f2edff] text-[#7255bd]' : role === 'verified' ? 'border-[#dcecff] bg-[#edf5ff] text-blue' : '';
  return (
    <span className={`tag ${tone}`}>
      {role !== 'normal' && <Icon name={role === 'official' ? 'globe' : 'shield'} className="size-3" />}
      {t.roles.roles[role]}
    </span>
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
    <div className="flex flex-col gap-5">
      <section className="card flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between md:p-6">
        <div className="min-w-0">
          <p className="eyebrow">{r.summary.eyebrow}</p>
          <h2 className="mt-2 flex flex-wrap items-center gap-2 text-[17px] font-bold">
            {r.summary.title}
            <RoleTag t={t} role={role} />
          </h2>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">{r.summary.note}</p>
        </div>
        <small className="flex-none text-[11px] text-muted">
          {overview.roleChangedAt ? fill(r.summary.updated, { date: formatDateTime(overview.roleChangedAt, locale) }) : r.summary.default}
        </small>
      </section>

      {role === 'official' ? (
        <section className="card flex items-start gap-3 bg-[#fbfaff] p-5 md:p-6">
          <Icon name="globe" className="mt-0.5 size-5 flex-none text-[#7255bd]" />
          <div>
            <h2 className="text-[15px] font-bold">{r.official.title}</h2>
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{r.official.body}</p>
          </div>
        </section>
      ) : role === 'verified' ? (
        <section className="card border-[#dbeee5] bg-[#f7fcfa] p-5 md:p-6">
          <h2 className="flex items-center gap-2 text-[15px] font-bold">
            <Icon name="shield" className="size-5 text-green" />
            {r.verified.title}
          </h2>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{r.verified.body}</p>
        </section>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
          <section className="card min-w-0 p-5 md:p-6">
            <h2 className="text-[15px] font-bold">{r.requirements.title}</h2>
            <p className="mt-1 text-[12px] text-muted">{r.requirements.lede}</p>
            <RequirementChecks t={t} locale={locale} metrics={overview.metrics} className="mt-3" />
            <p className="mt-3 text-[11px] leading-relaxed text-muted">{r.requirements.footnote}</p>
          </section>
          <section className="card min-w-0 p-5 md:p-6">
            <h2 className="text-[15px] font-bold">{r.apply.title}</h2>
            <RoleApplication eligible={access.eligible} note={stateNote} />
          </section>
        </div>
      )}

      <History overview={overview} t={t} locale={locale} />
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
        <article key={`request-${request.id}`} className="py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong className="text-[13px]">{h.application}</strong>
            <StatusTag status={request.status} t={t} />
          </div>
          <small className="mt-1 block text-[11px] text-muted">
            {date(request.createdAt)}
            {request.decidedAt && ` · ${fill(h.reviewed, { date: date(request.decidedAt) })}`}
          </small>
          <p className="mt-2 text-[12px] leading-relaxed break-words whitespace-pre-wrap">{request.statement}</p>
          {request.links.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1" aria-label={h.links}>
              {request.links.map((link) => (
                <li key={link} className="min-w-0">
                  <a href={link} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex max-w-full items-center gap-1 text-[12px] text-blue hover:underline">
                    <Icon name="external" className="size-3 flex-none" />
                    <span className="truncate">{link}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          {request.rejectedReason && (
            <div className="mt-3 rounded-lg border-l-2 border-[#d9e4f5] bg-[#f7f8fc] px-3.5 py-2.5">
              <strong className="text-[11px]">{request.status === 'rejected' ? h.rejection : h.note}</strong>
              <p className="mt-1 text-[12px] leading-relaxed break-words whitespace-pre-wrap text-muted">{request.rejectedReason}</p>
            </div>
          )}
          {request.closedByRoleChange && <p className="mt-2 text-[11px] text-muted">{h.closedByRole}</p>}
        </article>
      ),
    })),
    ...overview.events.map((event) => ({
      at: event.at.getTime(),
      node: (
        <article key={`event-${event.id}`} className="py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong className="text-[13px]">{fill(h.roleChange, { from: t.roles.roles[event.from], to: t.roles.roles[event.to] })}</strong>
            <small className="text-[11px] text-muted">{date(event.at)}</small>
          </div>
          {event.reason && <p className="mt-2 text-[12px] leading-relaxed break-words whitespace-pre-wrap text-muted">{event.reason}</p>}
        </article>
      ),
    })),
  ].sort((a, b) => b.at - a.at);
  return (
    <section className="card p-5 md:p-6">
      <h2 className="text-[15px] font-bold">{h.title}</h2>
      {entries.length ? <div className="mt-1 divide-y divide-line">{entries.map((entry) => entry.node)}</div> : <p className="mt-3 text-[12px] text-muted">{h.empty}</p>}
    </section>
  );
}

function StatusTag({ status, t }: { status: 'pending' | 'approved' | 'rejected' | 'closed'; t: Messages }) {
  const tone =
    status === 'approved'
      ? 'border-[#cfe9df] bg-[#eef8f4] text-green'
      : status === 'rejected'
        ? 'border-[#f1d4d4] bg-[#fff3f3] text-red'
        : status === 'pending'
          ? 'border-[#f3e2c6] bg-[#fdf7ec] text-orange'
          : '';
  return <span className={`tag ${tone}`}>{t.roles.history.status[status]}</span>;
}
