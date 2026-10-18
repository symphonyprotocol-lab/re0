import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExpertControls } from '@/components/admin/expert-controls';
import {
  ConsoleNotice,
  ConsolePageHeader,
  Fact,
  Panel,
  PanelHead,
  Pill,
  TableScroller,
  TD,
  TH,
} from '@/components/admin/ui';
import { AwardIcon, CheckIcon, CircleXIcon } from '@/components/ui/icons';
import { expertApplicationDetail } from '@/lib/application/expert-libraries';
import { APPROVAL_CHECKS } from '@/lib/domain/expert-library';
import { requireAdminCapability } from '@/lib/http/admin';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';
import { initialsOf, utcInstant, utcStamp } from '../../list-params';
import { decideExpertAction, revokeExpertAction } from '../actions';

type Params = { params: Promise<{ applicationId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const [{ applicationId }, t] = await Promise.all([params, getMessages()]);
  const application = await expertApplicationDetail(applicationId);
  if (!application) return { title: t.admin.expertDetail.title };
  return { title: fill(t.admin.expertDetail.metaTitle, { library: application.library.title }) };
}

const STATUS_TONE: Record<string, 'warn' | 'ok' | 'danger' | 'neutral'> = {
  pending: 'warn',
  approved: 'ok',
  rejected: 'danger',
  revoked: 'neutral',
  withdrawn: 'neutral',
};

function label(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}

/**
 * One application, with the checks an approval runs -- expert-library-prd.md
 * 6.3. The checks are the library as it stands at render time; the action
 * runs them again under the row lock, so what this page shows is advice and
 * the server's answer is the decision.
 */
export default async function AdminExpertDetailPage({ params }: Params) {
  const [, { applicationId }, t] = await Promise.all([
    requireAdminCapability('expertLibraries'),
    params,
    getMessages(),
  ]);
  const d = t.admin.expertDetail;
  const lifecycle = t.dashboard.libraryDetail.lifecycle;

  const application = await expertApplicationDetail(applicationId);
  if (!application) notFound();
  const library = application.library;

  const failing = APPROVAL_CHECKS.filter((check) => !application.checks[check]);

  return (
    <div className="flex flex-col gap-[18px]">
      <ConsolePageHeader
        eyebrow={d.eyebrow}
        title={library.title}
        description={library.publicId}
        action={
          <span className="flex flex-wrap items-center gap-2">
            <ExpertControls
              variant="button"
              target={{
                id: application.id,
                libraryTitle: library.title,
                libraryPublicId: library.publicId,
                workspaceName: application.applicant.name || '—',
                initial: initialsOf(library.title),
              }}
              status={application.status}
              approvable={application.approvable}
              decideAction={decideExpertAction}
              revokeAction={revokeExpertAction}
            />
          </span>
        }
      />

      <Link
        href="/admin/expert-libraries"
        className="text-[12px] tracking-[-0.023em] text-muted hover:text-ink"
      >
        {d.back}
      </Link>

      {application.status === 'pending' && failing.length > 0 ? (
        <ConsoleNotice
          icon={<AwardIcon size={18} />}
          title={d.ineligibleTitle}
          body={fill(d.ineligibleBody, {
            checks: failing.map((check) => d.checks[check]).join(d.listSeparator),
          })}
        />
      ) : null}

      <Panel>
        <PanelHead title={d.factsTitle} description={d.factsSubtitle} />
        <dl className="grid grid-cols-1 gap-x-6 px-[19px] py-1 sm:grid-cols-2">
          <Fact label={d.fields.id} value={<span className="font-mono">{application.id}</span>} />
          <Fact
            label={d.fields.library}
            value={
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{library.publicId}</span>
                {library.deletedAt ? <Pill tone="danger">{d.libraryDeleted}</Pill> : null}
                {library.expertTaggedAt ? <Pill tone="brand">{d.taggedBadge}</Pill> : null}
              </span>
            }
          />
          <Fact label={d.fields.applicant} value={application.applicant.name || '—'} />
          <Fact label={d.fields.currentOwner} value={library.ownerName ?? d.unowned} />
          <Fact
            label={d.fields.status}
            value={
              <Pill tone={STATUS_TONE[application.status] ?? 'neutral'}>
                {label(d.statuses, application.status)}
              </Pill>
            }
          />
          <Fact
            label={d.fields.libraryState}
            value={
              <span className="flex flex-wrap items-center gap-1.5">
                <Pill tone={library.visibility === 'public' ? 'brand' : 'neutral'}>
                  {library.visibility === 'public'
                    ? t.dashboard.libraries.scopePublic
                    : t.dashboard.libraries.scopePrivate}
                </Pill>
                <Pill tone={library.lifecycleStatus === 'published' ? 'ok' : 'warn'}>
                  {label(lifecycle, library.lifecycleStatus)}
                </Pill>
              </span>
            }
          />
          <Fact
            label={d.fields.ownerPlan}
            value={
              <span className="flex flex-wrap items-center gap-1.5">
                <span>{library.ownerPlanName ?? '—'}</span>
                <Pill tone={library.ownerSubscribed ? 'ok' : 'danger'}>
                  {library.ownerSubscribed ? d.subscribed : d.unsubscribed}
                </Pill>
              </span>
            }
          />
          <Fact label={d.fields.trustScore} value={String(library.trustScore)} />
          <Fact label={d.fields.createdAt} value={utcInstant(application.createdAt)} />
          <Fact label={d.fields.decidedAt} value={utcInstant(application.decidedAt) || '—'} />
          <Fact label={d.fields.taggedAt} value={utcInstant(library.expertTaggedAt) || '—'} />
          {application.decisionReason ? (
            <Fact
              label={d.fields.decision}
              value={fill(d.decidedBy, {
                admin: application.decidedByName ?? t.admin.audit.unknownAdmin,
                reason: application.decisionReason,
              })}
            />
          ) : null}
          <div className="sm:col-span-2">
            <Fact
              label={d.fields.note}
              value={
                application.note ? (
                  <span className="whitespace-pre-wrap">{application.note}</span>
                ) : (
                  d.noNote
                )
              }
            />
          </div>
        </dl>
      </Panel>

      <Panel>
        <PanelHead title={d.checksTitle} description={d.checksSubtitle} />
        <ul className="flex flex-col px-[19px]">
          {APPROVAL_CHECKS.map((check) => {
            const ok = application.checks[check];
            return (
              <li
                key={check}
                className="flex items-center justify-between gap-4 border-b border-line/70 py-3 last:border-b-0"
              >
                <span className="text-[12px] tracking-[-0.023em] text-steel">{d.checks[check]}</span>
                <span
                  className={`inline-flex shrink-0 items-center gap-1.5 text-[11.5px] font-semibold tracking-[-0.023em] ${
                    ok ? 'text-brand' : 'text-err'
                  }`}
                >
                  {ok ? <CheckIcon size={14} /> : <CircleXIcon size={14} />}
                  {ok ? d.checkStates.ok : d.checkStates.failed}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="border-t-2 border-line px-[19px] py-3 text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">
          {d.checksNote}
        </p>
      </Panel>

      <Panel>
        <PanelHead title={d.historyTitle} description={d.historySubtitle} />
        <TableScroller>
          <table className="w-full min-w-[640px] border-collapse text-left">
            <thead>
              <tr>
                {d.historyColumns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {application.history.map((row) => (
                <tr key={row.id} className="border-t-2 border-line">
                  <td className={`${TD} whitespace-nowrap`}>{utcStamp(row.createdAt)}</td>
                  <td className={TD}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Pill tone={STATUS_TONE[row.status] ?? 'neutral'}>
                        {label(d.statuses, row.status)}
                      </Pill>
                      {row.id === application.id ? <Pill tone="info">{d.thisOne}</Pill> : null}
                    </span>
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>{utcStamp(row.decidedAt) || '—'}</td>
                  <td className={TD}>{row.decisionReason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      </Panel>

      <Panel>
        <PanelHead title={d.auditTitle} description={d.auditSubtitle} />
        <TableScroller>
          <table className="w-full min-w-[680px] border-collapse text-left">
            <thead>
              <tr>
                {d.auditColumns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {application.audit.length === 0 ? (
                <tr className="border-t-2 border-line">
                  <td className={`${TD} text-center text-muted`} colSpan={d.auditColumns.length}>
                    {d.auditEmpty}
                  </td>
                </tr>
              ) : null}
              {application.audit.map((entry) => (
                <tr key={entry.id} className="border-t-2 border-line">
                  <td className={`${TD} whitespace-nowrap`}>{utcStamp(entry.createdAt)}</td>
                  <td className={TD}>{entry.administratorName ?? d.auditOwner}</td>
                  <td className={TD}>{label(t.admin.audit.actions, entry.action)}</td>
                  <td className={TD}>{entry.reason ?? '—'}</td>
                  <td className={TD}>{entry.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      </Panel>
    </div>
  );
}
