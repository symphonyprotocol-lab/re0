import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import {
  PlatformDeleteControl,
  PlatformLifecycleControl,
  PlatformRefreshControl,
  type PlatformLibraryTarget,
} from '@/components/admin/platform-library-controls';
import { PlatformLibraryFiles } from '@/components/admin/platform-library-files';
import { PlatformBenchmarkPanel } from '@/components/admin/platform-benchmark-panel';
import { PlatformProfilePanel } from '@/components/admin/platform-profile-panel';
import {
  AddPlatformSourceControl,
  EditPlatformLibraryControl,
  EditPlatformSourceControl,
  RemovePlatformSourceControl,
} from '@/components/admin/platform-library-edit';
import {
  ConsoleButton,
  ConsoleNotice,
  ConsolePageHeader,
  Fact,
  Metric,
  Panel,
  PanelHead,
  Pill,
  TableScroller,
  TD,
  TH,
} from '@/components/admin/ui';
import { ChevronLeftIcon, GlobeIcon } from '@/components/ui/icons';
import Link from 'next/link';
import {
  getLibraryBenchmark,
  getPlatformLibrary,
  type PlatformLibraryDetail,
} from '@/lib/application/administration';
import {
  documentsPage,
  documentsPageSize,
  DOCUMENTS_PAGE_SIZES,
  listVersionDocuments,
} from '@/lib/application/libraries';
import { isIngestionConfigured } from '@/lib/application/ingestion';
import type { FetchSummary } from '@/lib/domain/ingestion';
import { isPlatformLibraryType, type PlatformLibraryType } from '@/lib/domain/library';
import { requireAdminCapability, currentAdminSession } from '@/lib/http/admin';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';
import { bytes, initialsOf, utcInstant, utcStamp } from '../../list-params';
import {
  addEvalQuestionAction,
  addPlatformSourceAction,
  deletePlatformLibraryAction,
  preparePlatformUploadAction,
  rebuildPlatformLibraryProfileAction,
  refreshPlatformLibraryAction,
  removeEvalQuestionAction,
  removePlatformSourceAction,
  runLibraryEvaluationAction,
  setPlatformLifecycleAction,
  updatePlatformFilesAction,
  updatePlatformLibraryAction,
  updatePlatformSourceAction,
} from '../actions';

/**
 * The metadata and the page both need the library, and Next renders them as two
 * calls into this module. `cache` makes that one read per request.
 */
const loadLibrary = cache(getPlatformLibrary);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ libraryId: string }>;
}): Promise<Metadata> {
  const [{ libraryId }, t, session] = await Promise.all([
    params,
    getMessages(),
    currentAdminSession(),
  ]);

  /*
   * Entitlement first, even here. Metadata runs alongside the page rather than
   * after its guard, so without this an unentitled request would still read the
   * record out of the database.
   */
  if (!session?.capabilities.includes('platformLibraries')) {
    return { title: t.admin.platformLibraryDetail.title };
  }

  const record = await loadLibrary(libraryId);
  return {
    title: record
      ? fill(t.admin.platformLibraryDetail.metaTitle, { title: record.title })
      : t.admin.platformLibraryDetail.title,
  };
}

/**
 * One platform library in full -- design source frame `平台知识库详情`.
 *
 * The panels are ordered by what a decision about this library needs answering
 * in: what it is, where it comes from, what has been built from it, what is
 * queued, and what has already been done to it. The controls in the header
 * are the whole of requirement.md 5.3's verbs over a platform library apart
 * from creating it -- plus delete, from architecture.md 8.4 -- and each one
 * opens a confirmation that records a reason.
 *
 * Two panels here describe subsystems that are not running yet -- versions and
 * the refresh queue. They are shown anyway, with a note saying why they are
 * empty: an operator who has just queued a refresh needs somewhere to see that
 * the request exists, and "nothing visible happened" is the worst possible
 * answer to a button they were told to press.
 */
export default async function AdminPlatformLibraryPage({
  params,
  searchParams,
}: {
  params: Promise<{ libraryId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [, { libraryId }, query, t] = await Promise.all([
    requireAdminCapability('platformLibraries'),
    params,
    searchParams,
    getMessages(),
  ]);

  const record = await loadLibrary(libraryId);
  if (!record) notFound();

  const docsPage = documentsPage(query.docs);
  const docsSize = documentsPageSize(query.size);
  const documents = record.currentVersionId
    ? await listVersionDocuments({
        libraryId: record.id,
        versionId: record.currentVersionId,
        limit: docsSize,
        offset: (docsPage - 1) * docsSize,
      })
    : { documents: [], total: 0 };
  const docsPages = Math.max(1, Math.ceil(documents.total / docsSize));
  const benchmark = await getLibraryBenchmark(record.id);
  const docsHref = (page: number, size: number = docsSize) =>
    `/admin/platform-libraries/${record.id}?docs=${page}&size=${size}#documents`;

  const p = t.admin.platformLibraries;
  const d = t.admin.platformLibraryDetail;
  const number = (value: number) => value.toLocaleString('en-US');
  const stamp = (value: Date | null) => (value ? `${utcStamp(value)} UTC` : null);

  const sourceLabel = record.sources[0]
    ? label(p.sourceTypes, record.sources[0].type)
    : d.basics.none;

  /*
   * The type the Library ID's namespace is checked against on an edit. Taken
   * from the first source, falling back to `github` for a library whose sources
   * have all been removed -- `updatePlatformLibrary` re-derives it server side
   * either way, so this only decides which hint the form shows.
   */
  const firstType = record.sources[0]?.type;
  const sourceType: PlatformLibraryType = isPlatformLibraryType(firstType) ? firstType : 'github';

  /* Whether a queued refresh could actually build anything in this deployment. */
  const ingestionReady = await isIngestionConfigured();

  const target: PlatformLibraryTarget = {
    id: record.id,
    publicId: record.publicId,
    title: record.title,
    initial: initialsOf(record.title),
    sourceLabel,
  };

  return (
    <div className="flex flex-col gap-[18px]">
      <ConsolePageHeader
        eyebrow={d.eyebrow}
        title={record.title}
        description={fill(d.subtitle, {
          publicId: record.publicId,
          source: sourceLabel,
          synced: stamp(record.lastSyncedAt) ?? d.metrics.syncedNever,
        })}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ConsoleButton href="/admin/platform-libraries">
              <ChevronLeftIcon size={14} />
              {d.back}
            </ConsoleButton>
            <EditPlatformLibraryControl
              action={updatePlatformLibraryAction}
              target={target}
              library={{
                title: record.title,
                publicId: record.publicId,
                description: record.description,
                domainTag: record.domainTag,
                language: record.language,
                sourceType,
              }}
            />
            <PlatformRefreshControl
              action={refreshPlatformLibraryAction}
              target={target}
              variant="button"
              disabled={record.lifecycleStatus === 'archived'}
            />
            <PlatformLifecycleControl
              action={setPlatformLifecycleAction}
              target={target}
              current={record.lifecycleStatus}
              canPublish={record.hasReadyVersion}
            />
            <PlatformDeleteControl
              action={deletePlatformLibraryAction}
              target={target}
              variant="button"
            />
          </div>
        }
      />

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label={d.metrics.status}
          value={label(p.lifecycle, record.lifecycleStatus)}
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
          note={fill(d.metrics.storageNote, { tokens: number(record.tokens) })}
        />
        <Metric
          label={d.metrics.synced}
          value={record.lastSyncedAt ? utcStamp(record.lastSyncedAt) : d.metrics.syncedNever}
          /* "Last checked never" is a sentence; "Last checked <never checked>"
             is two of them collided, so the empty case gets its own line. */
          note={
            record.lastCheckedAt
              ? fill(d.metrics.syncedNote, { checked: utcStamp(record.lastCheckedAt) })
              : d.metrics.checkedNever
          }
        />
      </section>

      {/*
        * Only when a refresh could not build anything. A library with no
        * versions is an ordinary state -- it has simply not been refreshed --
        * and a standing notice over every new library would train operators to
        * ignore the one case that does need reading.
        */}
      {ingestionReady ? null : (
        <ConsoleNotice
          icon={<GlobeIcon size={18} />}
          title={d.versions.title}
          body={t.admin.notReady.ingestion}
        />
      )}

      <Panel className="overflow-hidden">
        <PanelHead title={d.basics.title} description={d.basics.description} />
        <dl className="grid grid-cols-1 gap-x-6 px-[19px] py-1.5 sm:grid-cols-2">
          <Fact label={d.basics.publicId} value={record.publicId} />
          <Fact label={d.basics.visibility} value={d.basics.visibilityValue} />
          <Fact label={d.basics.tag} value={record.domainTag ?? d.basics.none} />
          <Fact label={d.basics.language} value={record.language ?? d.basics.none} />
          {/* Only the index state. Lifecycle is its own fact (requirement.md 6.2
              keeps the two independent) and already leads the metrics above. */}
          <Fact label={d.basics.indexStatus} value={label(p.indexStatus, record.indexStatus)} />
          <Fact label={d.basics.created} value={`${utcStamp(record.createdAt)} UTC`} />
          <Fact label={d.basics.summary} value={record.description ?? d.basics.none} />
        </dl>
      </Panel>

      <Panel>
        <PanelHead
          title={d.sources.title}
          description={d.sources.namespaceNote}
          action={
            record.lifecycleStatus === 'archived' ? undefined : (
              <AddPlatformSourceControl
                action={addPlatformSourceAction}
                target={target}
                prepare={preparePlatformUploadAction}
              />
            )
          }
        />
        <TableScroller>
          <table className="w-full min-w-[620px] border-collapse text-left">
            <thead>
              <tr>
                {d.sources.columns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
                <th scope="col" className={`${TH} w-[120px]`}>
                  <span className="sr-only">{d.sources.actions}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {record.sources.length === 0 ? (
                <Empty columns={d.sources.columns.length + 1} message={d.sources.empty} />
              ) : null}
              {record.sources.map((source) => (
                <tr key={source.id} className="border-t-2 border-line">
                  <td className={TD}>
                    <Pill tone="info">{label(p.sourceTypes, source.type)}</Pill>
                  </td>
                  <td className={`${TD} break-all`}>{source.location}</td>
                  <td className={TD}>
                    {p.refreshPolicies[source.refreshPolicy]}
                    {source.type === 'website' && source.indexDepth > 0
                      ? ` · ${d.sourceDialog.indexDepths[source.indexDepth]}`
                      : ''}
                  </td>
                  <td className={TD}>
                    {/*
                      * Both controls are offered on every row, including the
                      * last one. Removing the last source is refused by the use
                      * case with a sentence explaining why; a button that
                      * silently disappears explains nothing.
                      */}
                    <span className="flex items-center gap-1.5">
                      <PlatformRefreshControl
                        action={refreshPlatformLibraryAction}
                        target={target}
                        source={{ id: source.id, location: source.location }}
                        disabled={record.lifecycleStatus === 'archived'}
                      />
                      {/* A pdf source has no location to edit: its files are
                          managed in the panel below. It can still be removed. */}
                      {source.type === 'pdf' ? null : (
                        <EditPlatformSourceControl
                          action={updatePlatformSourceAction}
                          target={target}
                          source={source}
                        />
                      )}
                      <RemovePlatformSourceControl
                        action={removePlatformSourceAction}
                        target={target}
                        source={source}
                      />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      </Panel>

      {record.files !== null ? (
        <PlatformLibraryFiles
          libraryId={record.id}
          files={record.files}
          building={record.operations.some(
            (operation) => operation.status === 'pending' || operation.status === 'running',
          )}
          canEdit={record.lifecycleStatus !== 'archived'}
          action={updatePlatformFilesAction}
          prepare={preparePlatformUploadAction}
        />
      ) : null}

      <PlatformProfilePanel
        profile={record.profile}
        target={target}
        action={rebuildPlatformLibraryProfileAction}
        stamp={utcStamp}
        t={d}
      />

      {benchmark ? (
        <PlatformBenchmarkPanel
          libraryId={record.id}
          view={benchmark}
          canEvaluate={record.currentVersionId !== null}
          addAction={addEvalQuestionAction}
          removeAction={removeEvalQuestionAction}
          runAction={runLibraryEvaluationAction}
        />
      ) : null}

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
                <Empty columns={d.documents.columns.length} message={d.documents.empty} />
              ) : null}
              {documents.documents.map((document) => (
                <tr key={document.id} className="border-t-2 border-line">
                  <td className={TD}>
                    <Link
                      href={`/admin/platform-libraries/${record.id}/documents/${document.id}`}
                      title={d.documents.preview}
                      className="text-brandink hover:text-brand"
                    >
                      {document.title}
                    </Link>
                  </td>
                  <td className={`${TD} break-all`}>
                    <a
                      href={document.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      title={d.documents.open}
                      className="text-muted hover:text-ink"
                    >
                      {document.sourceUrl}
                    </a>
                  </td>
                  <td className={TD}>{number(document.chunks)}</td>
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
              {docsPage > 1 ? (
                <ConsoleButton href={docsHref(docsPage - 1)}>{t.admin.actions.prev}</ConsoleButton>
              ) : null}
              {docsPage < docsPages ? (
                <ConsoleButton href={docsHref(docsPage + 1)}>{t.admin.actions.next}</ConsoleButton>
              ) : null}
            </span>
          </div>
        ) : null}
      </Panel>

      <Panel>
        <PanelHead title={d.versions.title} description={d.versions.description} />
        <TableScroller>
          <table className="w-full min-w-[720px] border-collapse text-left">
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
                <Empty
                  columns={d.versions.columns.length}
                  message={d.versions.empty}
                  note={ingestionReady ? d.versions.note : d.versions.notConfigured}
                />
              ) : null}
              {record.versions.map((version) => (
                <tr key={version.id} className="border-t-2 border-line">
                  <td className={TD}>{version.label}</td>
                  <td className={TD}>
                    <Pill tone={version.isCurrent ? 'ok' : 'neutral'}>
                      {version.isCurrent ? d.versions.current : d.versions.superseded}
                    </Pill>
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>
                    {number(version.documents)} / {number(version.totalChunks)}
                  </td>
                  <td className={`${TD} font-mono text-[11px] break-all`}>
                    {version.contentMerkleRoot ?? d.basics.none}
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
        <PanelHead title={d.queue.title} description={d.queue.description} />
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
                <Empty columns={d.queue.columns.length} message={d.queue.empty} />
              ) : null}
              {record.operations.map((operation) => (
                <tr key={operation.id} className="border-t-2 border-line">
                  <td className={TD}>
                    <span className="flex flex-col gap-0.5">
                      <span className="font-mono text-[11px]">{operation.operationType}</span>
                      {/* Who asked: the button, or the drain acting on a policy. */}
                      <span className="text-[11px] text-muted">
                        {label(t.admin.refreshQueue.triggers, operation.trigger)}
                        {operation.sourceId ? ` · ${sourceScope(record, operation.sourceId)}` : ''}
                      </span>
                    </span>
                  </td>
                  <td className={TD}>
                    <span className="flex flex-col items-start gap-1">
                      <Pill tone={operation.status === 'failed' ? 'danger' : 'neutral'}>
                        {operation.status}
                      </Pill>
                      {operation.error ? (
                        /* A stable code, rendered as the sentence it stands
                           for. The raw code is kept as the fallback so a build
                           whose dictionary is behind still says something. */
                        <span className="text-[11px] text-err">
                          {label(t.admin.ingestionErrors, operation.error)}
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>
                    {fetchMethodLabel(t, operation.fetchSummary)}
                  </td>
                  <td className={TD}>{operation.attempts}</td>
                  <td className={`${TD} whitespace-nowrap`}>{utcInstant(operation.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      </Panel>

      <Panel>
        <PanelHead title={d.audit.title} description={d.audit.description} />
        <TableScroller>
          <table className="w-full min-w-[640px] border-collapse text-left">
            <thead>
              <tr>
                {d.audit.columns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {record.audit.length === 0 ? (
                <Empty columns={d.audit.columns.length} message={d.audit.empty} />
              ) : null}
              {record.audit.map((entry) => (
                <tr key={entry.id} className="border-t-2 border-line">
                  <td className={`${TD} whitespace-nowrap`}>{utcInstant(entry.createdAt)}</td>
                  <td className={TD}>
                    {/* `action` is a machine code, so one this build has no
                        label for still reads as itself rather than as blank. */}
                    {actionLabel(t, entry.action)}
                  </td>
                  <td className={TD}>{entry.administrator ?? d.basics.none}</td>
                  <td className={TD}>{entry.reason ?? d.basics.none}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      </Panel>
    </div>
  );
}

function Empty({
  columns,
  message,
  note,
}: {
  columns: number;
  message: string;
  note?: string;
}) {
  return (
    <tr className="border-t-2 border-line">
      <td colSpan={columns} className="px-[15px] py-8 text-center">
        <p className="text-[13px] tracking-[-0.023em] text-steel">{message}</p>
        {note ? <p className="mt-1.5 text-[11px] text-muted">{note}</p> : null}
      </td>
    </tr>
  );
}

/**
 * How a build read its pages, as one phrase: our own fetch, a renderer, or
 * both with the split. A page rendered by a provider is content we did not
 * fetch ourselves, which is why a single rendered page is enough to name the
 * provider rather than round it away.
 */
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

/** The one source a refresh named, as its type and location; the id if it is gone. */
function sourceScope(record: PlatformLibraryDetail, sourceId: string): string {
  const source = record.sources.find((candidate) => candidate.id === sourceId);
  return source ? `${source.type} · ${source.location}` : sourceId.slice(0, 8);
}

function actionLabel(t: Dictionary, action: string): string {
  const labels: Record<string, string> = t.admin.audit.actions;
  return labels[action] ?? action;
}

function label(dictionary: Record<string, string>, value: string): string {
  return dictionary[value] ?? value;
}
