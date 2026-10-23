import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import {
  ConsoleButton,
  ConsoleNotice,
  ConsolePageHeader,
  EmptyRow,
  Fact,
  Metric,
  Panel,
  PanelHead,
  Pill,
  TableScroller,
  TD,
  TH,
} from '@/components/admin/ui';
import { PlatformBenchmarkPanel } from '@/components/admin/platform-benchmark-panel';
import { ReviewProbe } from '@/components/admin/review-probe';
import { describeReviewNote } from '@/lib/domain/review';
import { UserReviewControls } from '@/components/admin/user-library-controls';
import Link from 'next/link';
import { ChevronLeftIcon, LockIcon } from '@/components/ui/icons';
import {
  getLibraryBenchmark,
  getUserLibrary,
  listFlaggedDocuments,
  listReviewDocuments,
  reviewScore,
} from '@/lib/application/administration';
import { documentsPage, documentsPageSize, DOCUMENTS_PAGE_SIZES } from '@/lib/application/libraries';
import { currentAdminSession, requireAdminCapability } from '@/lib/http/admin';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';
import { bytes, initialsOf, utcStamp } from '../../list-params';
import {
  addReviewEvalQuestionAction,
  adoptReviewEvalQuestionAction,
  probeUserLibraryAction,
  removeReviewEvalQuestionAction,
  reviewUserLibraryAction,
  runReviewEvaluationAction,
} from '../actions';

const loadLibrary = cache(getUserLibrary);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ libraryId: string }>;
}): Promise<Metadata> {
  const [{ libraryId }, t, session] = await Promise.all([params, getMessages(), currentAdminSession()]);
  const d = t.admin.libraries.detail;
  /* Entitlement first: metadata runs alongside the page, not after its guard. */
  if (!session?.capabilities.includes('libraries')) return { title: d.title };
  const record = await loadLibrary(libraryId);
  return { title: record ? fill(d.metaTitle, { title: record.title }) : d.title };
}

const LIFECYCLE_TONE: Record<string, 'warn' | 'ok' | 'danger' | 'neutral'> = {
  draft: 'neutral',
  submitted: 'warn',
  reviewing: 'warn',
  changes_requested: 'danger',
  published: 'ok',
  suspended: 'danger',
  archived: 'neutral',
};

/**
 * One user library, for the reviewer: what it is, where it comes from, what
 * has been built, what it says, and what has already been decided about it.
 * requirement.md 7.4 lists what a review checks, and for a public library
 * this page shows what those checks need (review-visibility-proposal.md 4):
 * the scores, the test set, the scan's findings, the documents, and a probe.
 * A private library is never reviewed, so for it the page keeps to sources
 * and counts -- its content stays the owner's.
 */
export default async function AdminUserLibraryPage({
  params,
  searchParams,
}: {
  params: Promise<{ libraryId: string }>;
  searchParams: Promise<{ docs?: string; size?: string }>;
}) {
  const [, { libraryId }, query, t] = await Promise.all([
    requireAdminCapability('libraries'),
    params,
    searchParams,
    getMessages(),
  ]);
  const record = await loadLibrary(libraryId);
  if (!record) notFound();

  const reviewing = record.visibility === 'public';
  const docsPage = documentsPage(query.docs);
  const docsSize = documentsPageSize(query.size);
  const versionId = record.versions.find((version) => version.isCurrent)?.id ?? null;
  const [score, benchmark, documents, flagged] = reviewing
    ? await Promise.all([
        reviewScore(record.id),
        getLibraryBenchmark(record.id),
        versionId
          ? listReviewDocuments({ libraryId: record.id, versionId, limit: docsSize, offset: (docsPage - 1) * docsSize })
          : Promise.resolve({ documents: [], total: 0 }),
        versionId ? listFlaggedDocuments({ libraryId: record.id, versionId }) : Promise.resolve([]),
      ])
    : [null, null, { documents: [], total: 0 }, []];
  const docsPages = Math.max(1, Math.ceil(documents.total / docsSize));
  const docsHref = (page: number, size: number = docsSize) =>
    `/admin/libraries/${record.id}?docs=${page}&size=${size}#documents`;

  const l = t.admin.libraries;
  const d = l.detail;
  const p = t.admin.platformLibraries;
  const number = (value: number) => value.toLocaleString('en-US');
  const lifecycle = (status: string) => label(l.lifecycle, status);
  const visibility =
    record.visibility === 'public' ? t.adminDemo.scope.public : t.adminDemo.scope.private;

  const target = {
    id: record.id,
    publicId: record.publicId,
    title: record.title,
    initial: initialsOf(record.title),
    sourceLabel: record.sources[0] ? label(p.sourceTypes, record.sources[0].type) : d.basics.none,
  };

  return (
    <div className="flex flex-col gap-[18px]">
      <ConsolePageHeader
        eyebrow={d.eyebrow}
        title={record.title}
        description={fill(d.subtitle, {
          publicId: record.publicId,
          owner: record.ownerName ?? d.basics.none,
          visibility,
        })}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ConsoleButton href="/admin/libraries">
              <ChevronLeftIcon size={14} />
              {d.back}
            </ConsoleButton>
            <UserReviewControls
              action={reviewUserLibraryAction}
              target={target}
              current={record.lifecycleStatus}
              visibility={record.visibility}
              canApprove={record.hasReadyVersion}
              variant="button"
            />
          </div>
        }
      />

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label={d.metrics.status}
          value={lifecycle(record.lifecycleStatus)}
          note={
            record.currentVersionLabel
              ? fill(d.metrics.statusNote, { label: record.currentVersionLabel })
              : d.metrics.statusNoteNone
          }
        />
        <Metric
          label={d.metrics.documents}
          value={number(record.documents)}
          note={fill(d.metrics.documentsNote, { chunks: number(record.chunks) })}
        />
        <Metric
          label={d.metrics.storage}
          value={bytes(record.storageBytes)}
          note={fill(d.metrics.created, { created: utcStamp(record.createdAt) })}
        />
        <Metric
          label={d.metrics.synced}
          value={record.lastSyncedAt ? utcStamp(record.lastSyncedAt) : d.metrics.syncedNever}
          note={label(l.lifecycleNote, record.lifecycleStatus)}
        />
      </section>

      {record.visibility === 'private' ? (
        <ConsoleNotice icon={<LockIcon size={18} />} title={visibility} body={l.privateNote} />
      ) : null}

      <Panel className="overflow-hidden">
        <PanelHead title={d.basics.title} description={d.basics.description} />
        <dl className="grid grid-cols-1 gap-x-6 px-[19px] py-1.5 sm:grid-cols-2">
          <Fact label={d.basics.publicId} value={record.publicId} />
          <Fact label={d.basics.owner} value={record.ownerName ?? d.basics.none} />
          <Fact label={d.basics.visibility} value={visibility} />
          <Fact label={d.basics.language} value={record.language ?? d.basics.none} />
          <Fact label={d.basics.indexStatus} value={label(p.indexStatus, record.indexStatus)} />
          <Fact label={d.basics.created} value={`${utcStamp(record.createdAt)} UTC`} />
          <Fact label={d.basics.summary} value={record.description ?? d.basics.none} />
        </dl>
      </Panel>

      <Panel>
        <PanelHead title={d.sources.title} description={d.sources.description} />
        <TableScroller>
          <table className="w-full min-w-[560px] border-collapse text-left">
            <thead>
              <tr>
                {d.sources.columns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {record.sources.length === 0 ? (
                <EmptyRow columns={d.sources.columns.length} message={d.sources.empty} />
              ) : null}
              {record.sources.map((source) => (
                <tr key={source.id} className="border-t-2 border-line">
                  <td className={TD}>
                    <Pill tone="info">{label(p.sourceTypes, source.type)}</Pill>
                  </td>
                  <td className={`${TD} break-all`}>{source.location}</td>
                  <td className={TD}>{source.fileCount === null ? d.basics.none : number(source.fileCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      </Panel>

      {reviewing ? (
        <>
          {/* What the owner declared, and the question set the expert gate judges (review-visibility-proposal.md 5). */}
          <Panel>
            <PanelHead title={d.materials.title} description={d.materials.description} />
            <dl className="grid grid-cols-1 gap-x-6 px-[19px] py-1 sm:grid-cols-2">
              {record.materials.rights ? (
                <>
                  <Fact label={d.materials.origin} value={label(d.materials.origins, record.materials.rights.origin)} />
                  <Fact label={d.materials.license} value={label(d.materials.licenses, record.materials.rights.license)} />
                  <Fact label={d.materials.generation} value={label(d.materials.generations, record.materials.rights.generation)} />
                  <Fact
                    label={d.materials.declaredAt}
                    value={record.materials.rights.declaredAt ? `${utcStamp(new Date(record.materials.rights.declaredAt))} UTC` : d.basics.none}
                  />
                  <div className="sm:col-span-2">
                    <Fact
                      label={d.materials.note}
                      value={record.materials.rights.note ? <span className="whitespace-pre-wrap">{record.materials.rights.note}</span> : d.basics.none}
                    />
                  </div>
                </>
              ) : (
                <div className="sm:col-span-2">
                  <Fact label={d.materials.rights} value={<Pill tone="danger">{d.materials.undeclared}</Pill>} />
                </div>
              )}
              <Fact
                label={d.materials.questions}
                value={fill(d.materials.questionsValue, { total: record.materials.questions, owner: record.materials.ownerQuestions })}
              />
            </dl>
          </Panel>

          {/* What the review checks (7.4 item 5), and what the build measured. */}
          <Panel>
            <PanelHead title={d.scores.title} description={d.scores.description} />
            {score ? (
              <dl className="grid grid-cols-1 gap-x-6 px-[19px] py-1 sm:grid-cols-2">
                <Fact label={d.scores.trust} value={String(score.trustScore)} />
                <Fact label={d.scores.benchmark} value={String(score.benchmarkScore)} />
                <Fact label={d.scores.flaggedFiles} value={number(score.breakdown.flaggedFiles ?? 0)} />
                <Fact label={d.scores.quarantinedFiles} value={number(score.breakdown.quarantinedFiles ?? 0)} />
                <Fact label={d.scores.duplicates} value={number(score.breakdown.duplicates ?? 0)} />
                <Fact label={d.scores.computedAt} value={`${utcStamp(score.computedAt)} UTC`} />
              </dl>
            ) : (
              <p className="px-[19px] py-4 text-[12px] tracking-[-0.023em] text-muted">{d.scores.none}</p>
            )}
            <p className="border-t-2 border-line px-[19px] py-3 text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">
              {d.scores.note}
            </p>
          </Panel>

          {benchmark ? (
            <PlatformBenchmarkPanel
              libraryId={record.id}
              view={benchmark}
              canEvaluate={versionId !== null}
              addAction={addReviewEvalQuestionAction}
              removeAction={removeReviewEvalQuestionAction}
              runAction={runReviewEvaluationAction}
              adoptAction={adoptReviewEvalQuestionAction}
            />
          ) : null}

          <ReviewProbe libraryId={record.id} ready={record.hasReadyVersion} action={probeUserLibraryAction} />

          {/* 7.4 item 4: what the scan found, and where. */}
          <Panel>
            <PanelHead title={d.safety.title} description={d.safety.description} />
            <TableScroller>
              <table className="w-full min-w-[620px] border-collapse text-left">
                <thead>
                  <tr>
                    {d.safety.columns.map((column) => (
                      <th key={column} scope="col" className={TH}>
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {flagged.length === 0 ? (
                    <EmptyRow columns={d.safety.columns.length} message={versionId ? d.safety.empty : d.safety.noVersion} />
                  ) : null}
                  {flagged.map((document) => (
                    <tr key={document.id} className="border-t-2 border-line">
                      <td className={TD}>
                        <Link href={`/admin/libraries/${record.id}/documents/${document.id}`} className="text-brandink hover:text-brand">
                          {document.title}
                        </Link>
                      </td>
                      <td className={TD}>
                        <span className="flex flex-wrap gap-1">
                          {document.safetyFindings.map((finding) => (
                            <Pill key={finding} tone="warn">
                              {label(d.safety.findings, finding)}
                            </Pill>
                          ))}
                        </span>
                      </td>
                      <td className={TD}>
                        {number(document.flaggedChunks)} / {number(document.chunks)}
                      </td>
                      <td className={`${TD} break-all`}>
                        <a href={document.sourceUrl} target="_blank" rel="noreferrer" className="text-muted hover:text-ink">
                          {document.sourceUrl}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroller>
          </Panel>

          {/* 7.4 items 1 to 3: the documents themselves, as they will be served. */}
          <div id="documents" className="scroll-mt-4" />
          <Panel>
            <PanelHead title={d.documents.title} description={d.documents.description} />
            <TableScroller>
              <table className="w-full min-w-[620px] border-collapse text-left">
                <thead>
                  <tr>
                    {d.documents.columns.map((column) => (
                      <th key={column} scope="col" className={TH}>
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {documents.documents.length === 0 ? (
                    <EmptyRow columns={d.documents.columns.length} message={versionId ? d.documents.empty : d.safety.noVersion} />
                  ) : null}
                  {documents.documents.map((document) => (
                    <tr key={document.id} className="border-t-2 border-line">
                      <td className={TD}>
                        <Link
                          href={`/admin/libraries/${record.id}/documents/${document.id}`}
                          title={d.documents.read}
                          className="text-brandink hover:text-brand"
                        >
                          {document.title}
                        </Link>
                      </td>
                      <td className={`${TD} break-all`}>
                        <a href={document.sourceUrl} target="_blank" rel="noreferrer" className="text-muted hover:text-ink">
                          {document.sourceUrl}
                        </a>
                      </td>
                      <td className={TD}>{number(document.chunks)}</td>
                      <td className={TD}>
                        {document.safetyFindings.length > 0 || document.flaggedChunks > 0 ? (
                          <Pill tone="warn">{d.documents.flagged}</Pill>
                        ) : (
                          <Pill tone="ok">{d.documents.clean}</Pill>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroller>
            {documents.total > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t-2 border-line px-4 py-[11px]">
                <p className="text-[12px] tracking-[-0.023em] text-muted">
                  {fill(d.documents.page, { page: docsPage, pages: docsPages })} ·{' '}
                  {fill(d.documents.showing, { shown: documents.documents.length, total: documents.total })}
                </p>
                <span className="flex items-center gap-2">
                  <span className="flex items-center gap-1 text-[11px] text-muted">
                    {d.documents.pageSize}
                    {DOCUMENTS_PAGE_SIZES.map((size) => (
                      <Link
                        key={size}
                        href={docsHref(1, size)}
                        aria-current={size === docsSize ? 'true' : undefined}
                        className={`rounded-[5px] px-1.5 py-0.5 ${
                          size === docsSize ? 'bg-subtle font-semibold text-ink' : 'hover:text-ink'
                        }`}
                      >
                        {size}
                      </Link>
                    ))}
                  </span>
                  {docsPage > 1 ? <ConsoleButton href={docsHref(docsPage - 1)}>{t.admin.actions.prev}</ConsoleButton> : null}
                  {docsPage < docsPages ? <ConsoleButton href={docsHref(docsPage + 1)}>{t.admin.actions.next}</ConsoleButton> : null}
                </span>
              </div>
            ) : null}
          </Panel>
        </>
      ) : null}

      <Panel>
        <PanelHead title={d.reviews.title} description={d.reviews.description} />
        <TableScroller>
          <table className="w-full min-w-[620px] border-collapse text-left">
            <thead>
              <tr>
                {d.reviews.columns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {record.reviews.length === 0 ? (
                <EmptyRow columns={d.reviews.columns.length} message={d.reviews.empty} />
              ) : null}
              {record.reviews.map((review) => (
                <tr key={review.id} className="border-t-2 border-line">
                  <td className={`${TD} whitespace-nowrap`}>{utcStamp(review.decidedAt ?? review.createdAt)}</td>
                  <td className={TD}>
                    <Pill
                      tone={
                        review.outcome === 'approve' ? 'ok' : review.outcome === 'reject' ? 'danger' : 'warn'
                      }
                    >
                      {review.stage === 'sample' && !review.outcome
                        ? d.reviews.sampleOpen
                        : label(d.reviews.outcomes, review.outcome ?? '')}
                      {review.stage !== 'manual' ? ` · ${label(d.reviews.stages, review.stage)}` : ''}
                    </Pill>
                  </td>
                  <td className={TD}>{review.reviewerEmail ?? d.basics.none}</td>
                  <td className={TD}>
                    {review.feedback.map((line) => describeReviewNote(line, t.dashboard.libraries.rulesReasons)).join(' ') || d.basics.none}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      </Panel>

      <Panel>
        <PanelHead title={d.versions.title} />
        <TableScroller>
          <table className="w-full min-w-[560px] border-collapse text-left">
            <thead>
              <tr>
                {d.versions.columns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {record.versions.length === 0 ? (
                <EmptyRow columns={d.versions.columns.length} message={d.versions.empty} />
              ) : null}
              {record.versions.map((version) => (
                <tr key={version.id} className="border-t-2 border-line">
                  <td className={TD}>
                    <span className="flex items-center gap-2">
                      {version.label}
                      {version.isCurrent ? <Pill tone="brand">{d.versions.current}</Pill> : null}
                    </span>
                  </td>
                  <td className={TD}>
                    <Pill tone={version.indexStatus === 'ready' ? 'ok' : 'neutral'}>
                      {label(p.indexStatus, version.indexStatus)}
                    </Pill>
                  </td>
                  <td className={TD}>
                    {number(version.documents)} / {number(version.totalChunks)}
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>
                    {version.publishedAt ? utcStamp(version.publishedAt) : d.basics.none}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      </Panel>

      <Panel>
        <PanelHead title={d.queue.title} />
        <TableScroller>
          <table className="w-full min-w-[560px] border-collapse text-left">
            <thead>
              <tr>
                {d.queue.columns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {record.operations.length === 0 ? (
                <EmptyRow columns={d.queue.columns.length} message={d.queue.empty} />
              ) : null}
              {record.operations.map((operation) => (
                <tr key={operation.id} className="border-t-2 border-line">
                  <td className={TD}>{operation.operationType}</td>
                  <td className={TD}>
                    <Pill
                      tone={
                        operation.status === 'succeeded'
                          ? 'ok'
                          : operation.status === 'failed'
                            ? 'danger'
                            : LIFECYCLE_TONE[operation.status] ?? 'neutral'
                      }
                    >
                      {operation.status}
                    </Pill>
                  </td>
                  <td className={TD}>{operation.attempts}</td>
                  <td className={TD}>{operation.error ?? d.basics.none}</td>
                  <td className={`${TD} whitespace-nowrap`}>{utcStamp(operation.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      </Panel>
    </div>
  );
}

function label(dictionary: Record<string, string>, value: string): string {
  return dictionary[value] ?? value;
}
