import type { Metadata } from 'next';
import Link from 'next/link';
import { LiveRefresh } from '@/components/dashboard/live-refresh';
import {
  CONSOLE_PANEL,
  ConsoleButton,
  ConsolePageHeader,
  Panel,
  PanelHead,
  Pill,
  TableScroller,
  TD,
  TH,
  TitleCell,
} from '@/components/admin/ui';
import { ChevronLeftIcon, ClockIcon, RefreshIcon } from '@/components/ui/icons';
import { listRefreshQueue, type RefreshQueueRow } from '@/lib/application/administration';
import { refreshSchedule, type ScheduledSource } from '@/lib/application/ingestion';
import { describeBuild } from '@/lib/dashboard/build-progress';
import type { FetchSummary } from '@/lib/domain/ingestion';
import { requireAdminCapability } from '@/lib/http/admin';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';
import { utcInstant, utcStamp } from '../list-params';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).admin.refreshQueue.title };
}

/** Finished operations kept on screen; older ones are on each library's page. */
const RECENT_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The refresh queue across every platform library.
 *
 * Three readings of the same table, in the order an operator asks for them:
 * what is happening now (running, then waiting), what just happened (the
 * newest finished operations, whichever way they ended), and what will happen
 * (each source against its refresh policy, due first). The page re-renders
 * itself every few seconds while anything is open, so a build's progress and
 * the drain's pickup of a due source both show without a reload.
 */
export default async function AdminRefreshQueuePage() {
  const [, t] = await Promise.all([requireAdminCapability('platformLibraries'), getMessages()]);
  const q = t.admin.refreshQueue;
  const now = new Date();

  const [queue, schedule] = await Promise.all([
    listRefreshQueue({ recentLimit: RECENT_LIMIT, now }),
    refreshSchedule(now),
  ]);

  const live = queue.open.length > 0;
  const dueSoon = schedule.filter(
    (row) => row.dueAt !== null && row.dueAt.getTime() <= now.getTime() + DAY_MS,
  );
  const overdue = dueSoon.filter((row) => row.dueAt!.getTime() <= now.getTime() && !row.open);
  const number = (value: number) => value.toLocaleString('en-US');

  const stats = [
    { label: q.stats.running, value: number(queue.counts.running), caption: q.stats.runningCaption },
    { label: q.stats.pending, value: number(queue.counts.pending), caption: q.stats.pendingCaption },
    {
      label: q.stats.finished,
      value: number(queue.counts.succeeded + queue.counts.skipped + queue.counts.failed),
      caption: fill(q.stats.finishedCaption, {
        succeeded: number(queue.counts.succeeded),
        skipped: number(queue.counts.skipped),
        failed: number(queue.counts.failed),
      }),
    },
    {
      label: q.stats.dueSoon,
      value: number(dueSoon.length),
      caption: fill(q.stats.dueSoonCaption, { overdue: number(overdue.length) }),
    },
  ];

  return (
    <div className="flex flex-col gap-[18px]">
      <LiveRefresh active={live} />
      <ConsolePageHeader
        eyebrow={q.eyebrow}
        title={q.title}
        description={q.description}
        action={
          <ConsoleButton href="/admin/platform-libraries">
            <ChevronLeftIcon size={14} />
            {q.back}
          </ConsoleButton>
        }
      />

      <section className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <article
            key={stat.label}
            className={`${CONSOLE_PANEL} flex items-start gap-2.5 rounded-[9px] p-4`}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[8px] bg-brandsoft text-brand">
              <RefreshIcon size={16} />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[18px] leading-[1.3] font-semibold tracking-[-0.03em] text-ink">
                {stat.value}
              </span>
              <span className="truncate text-[11px] tracking-[-0.023em] text-muted">
                {stat.label}
              </span>
              <span className="text-[11px] leading-[1.5] tracking-[-0.023em] text-faint">
                {stat.caption}
              </span>
            </span>
          </article>
        ))}
      </section>

      <p className="flex items-center gap-1.5 text-[11px] tracking-[-0.023em] text-muted">
        <ClockIcon size={12} />
        {live ? q.live : q.idle}
      </p>

      <Panel>
        <PanelHead title={q.open.title} description={q.open.description} />
        <TableScroller>
          <table className="w-full min-w-[900px] border-collapse text-left">
            <thead>
              <tr>
                {q.open.columns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {queue.open.length === 0 ? (
                <Empty columns={q.open.columns.length} message={q.open.empty} />
              ) : null}
              {queue.open.map((operation) => (
                <tr key={operation.id} className="border-t-2 border-line">
                  <td className={TD}>
                    <LibraryCell row={operation} />
                  </td>
                  <td className={TD}>{scopeLabel(t, operation)}</td>
                  <td className={TD}>{label(q.triggers, operation.trigger)}</td>
                  <td className={TD}>
                    <StateCell t={t} row={operation} />
                  </td>
                  <td className={TD}>{operation.attempts}</td>
                  <td className={`${TD} whitespace-nowrap`}>{utcInstant(operation.createdAt)}</td>
                  <td className={`${TD} whitespace-nowrap`}>{utcInstant(operation.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      </Panel>

      <Panel>
        <PanelHead
          title={q.recent.title}
          description={fill(q.recent.description, { limit: String(RECENT_LIMIT) })}
        />
        <TableScroller>
          <table className="w-full min-w-[900px] border-collapse text-left">
            <thead>
              <tr>
                {q.recent.columns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {queue.recent.length === 0 ? (
                <Empty columns={q.recent.columns.length} message={q.recent.empty} />
              ) : null}
              {queue.recent.map((operation) => (
                <tr key={operation.id} className="border-t-2 border-line">
                  <td className={TD}>
                    <LibraryCell row={operation} />
                  </td>
                  <td className={TD}>{scopeLabel(t, operation)}</td>
                  <td className={TD}>{label(q.triggers, operation.trigger)}</td>
                  <td className={TD}>
                    <StateCell t={t} row={operation} />
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>
                    {fetchMethodLabel(t, operation.fetchSummary)}
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>{utcInstant(operation.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      </Panel>

      <Panel>
        <PanelHead title={q.schedule.title} description={q.schedule.description} />
        <TableScroller>
          <table className="w-full min-w-[820px] border-collapse text-left">
            <thead>
              <tr>
                {q.schedule.columns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {schedule.length === 0 ? (
                <Empty columns={q.schedule.columns.length} message={q.schedule.empty} />
              ) : null}
              {schedule.map((source) => (
                <tr key={source.sourceId} className="border-t-2 border-line">
                  <td className={TD}>
                    <Link
                      href={`/admin/platform-libraries/${source.libraryId}`}
                      className="flex flex-col gap-0.5 hover:underline"
                    >
                      <span className="text-[12px] font-semibold text-ink">{source.title}</span>
                      <span className="font-mono text-[11px] text-muted">{source.publicId}</span>
                    </Link>
                  </td>
                  <td className={`${TD} max-w-[300px]`}>
                    <span className="flex flex-col gap-0.5">
                      <span>{label(t.admin.platformLibraries.sourceTypes, source.sourceType)}</span>
                      <span className="truncate font-mono text-[11px] text-muted">{source.location}</span>
                    </span>
                  </td>
                  <td className={TD}>{label(t.admin.platformLibraries.refreshPolicies, source.policy)}</td>
                  <td className={`${TD} whitespace-nowrap`}>
                    {source.lastCheckedAt ? utcStamp(source.lastCheckedAt) : q.schedule.never}
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>
                    <DueCell t={t} source={source} now={now} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      </Panel>
    </div>
  );
}

function LibraryCell({ row }: { row: RefreshQueueRow }) {
  return (
    <Link href={`/admin/platform-libraries/${row.libraryId}`} className="hover:underline">
      <TitleCell title={row.title} meta={row.publicId} />
    </Link>
  );
}

/** Which sources the operation fetches: one, named, or all of them. */
function scopeLabel(t: Dictionary, row: RefreshQueueRow): string {
  const type = label(t.admin.refreshQueue.types, row.operationType);
  if (!row.sourceId) return `${type} · ${t.admin.refreshQueue.scope.all}`;
  const source = row.sourceType
    ? label(t.admin.platformLibraries.sourceTypes, row.sourceType)
    : row.sourceId.slice(0, 8);
  return `${type} · ${source}${row.location ? ` · ${row.location}` : ''}`;
}

const STATE_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  running: 'warn',
  succeeded: 'ok',
  failed: 'danger',
};

function StateCell({ t, row }: { t: Dictionary; row: RefreshQueueRow }) {
  const q = t.admin.refreshQueue;
  /* Where a running build is, from what it reported (BuildProgress). */
  const where = row.status === 'running' ? describeBuild(q, row) : null;
  return (
    <span className="flex flex-col items-start gap-1">
      <Pill tone={STATE_TONE[row.status] ?? 'neutral'}>
        {label(q.states, row.status)}
      </Pill>
      {where ? <span className="text-[11px] text-muted">{where}</span> : null}
      {row.error ? (
        <span className="text-[11px] text-err">{label(t.admin.ingestionErrors, row.error)}</span>
      ) : null}
    </span>
  );
}

/**
 * When the policy next asks for a check. "Queued" wins over "due now": once a
 * refresh covers the source, the time no longer says anything the queue above
 * does not.
 */
function DueCell({ t, source, now }: { t: Dictionary; source: ScheduledSource; now: Date }) {
  const q = t.admin.refreshQueue.schedule;
  if (source.open) return <Pill tone="warn">{q.queued}</Pill>;
  if (!source.dueAt) return <span className="text-muted">{q.manual}</span>;
  if (source.dueAt.getTime() <= now.getTime()) return <Pill tone="danger">{q.dueNow}</Pill>;
  return <>{utcStamp(source.dueAt)}</>;
}

function fetchMethodLabel(t: Dictionary, summary: FetchSummary | null): string {
  const f = t.admin.platformLibraryDetail.queue.fetch;
  if (!summary) return f.none;
  const provider = summary.renderer ? f.providers[summary.renderer] : '';
  if (summary.rendered === 0) return f.direct;
  if (summary.direct === 0) return fill(f.rendered, { provider });
  return fill(f.mixed, {
    provider,
    rendered: String(summary.rendered),
    total: String(summary.direct + summary.rendered),
  });
}

function Empty({ columns, message }: { columns: number; message: string }) {
  return (
    <tr className="border-t-2 border-line">
      <td colSpan={columns} className="px-[15px] py-8 text-center">
        <p className="text-[13px] tracking-[-0.023em] text-steel">{message}</p>
      </td>
    </tr>
  );
}

function label(dictionary: Record<string, string>, value: string): string {
  return dictionary[value] ?? value;
}
