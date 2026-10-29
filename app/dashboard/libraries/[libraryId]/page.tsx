import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LibraryMaterialsPanel } from '@/components/dashboard/library-materials';
import { LiveRefresh } from '@/components/dashboard/live-refresh';
import { listLibraryEvalQuestions } from '@/lib/application/libraries/materials';
import { describeBuild } from '@/lib/dashboard/build-progress';
import {
  DetailDeleteControl,
  LibraryMetadataForm,
  OwnerActionButton,
  ParseScopeForm,
  ReviewPipeline,
} from '@/components/dashboard/library-manage';
import { RebuildLibraryButton } from '@/components/dashboard/library-rebuild';
import { LibraryFaqPanel } from '@/components/dashboard/library-faq';
import { LibraryWidgetPanel } from '@/components/dashboard/library-widget';
import { LibraryShowcasePanel } from '@/components/dashboard/library-showcase';
import { BackLink, Badge, IconTile, PANEL, StatusLabel, type StatusTone } from '@/components/dashboard/ui';
import {
  ArrowRightIcon,
  BadgeCheckIcon,
  ClockIcon,
  DatabaseIcon,
  FileTextIcon,
  LockIcon,
  RefreshIcon,
  ShieldCheckIcon,
} from '@/components/ui/icons';
import {
  canManageLibraries,
  documentsPage,
  documentsPageSize,
  DOCUMENTS_PAGE_SIZES,
  LIBRARY_USAGE_PAGE_SIZE,
  libraryUsageLog,
  listVersionDocuments,
  workspaceLibraryDetail,
} from '@/lib/application/libraries';
import {
  countWorkspaceSiteKeys,
  EXCHANGE_PAGE_SIZE,
  listFaqEntries,
  listFaqGroups,
  listSiteKeys,
  listWidgetExchanges,
  SITE_KEYS_PER_LIBRARY,
  siteKeyEntitlement,
  widgetExchangeStats,
} from '@/lib/application/embed';
import { expertPanel } from '@/lib/application/expert-libraries';
import { qrCodeSvg } from '@/lib/application/administration/qr-code';
import {
  countWorkspaceShowcases,
  customDomainsAvailable,
  libraryShowcase,
  listShowcaseLeads,
  showcaseDomainFor,
  showcaseEntitlement,
  showcaseStats,
} from '@/lib/application/showcase';
import { siteKeysAllowed } from '@/lib/domain/plans';
import { describeReviewNote } from '@/lib/domain/review';
import { rightsAllowPublic } from '@/lib/domain/rights';
import { showcasePagesAllowed, showcasePath } from '@/lib/domain/showcase';
import { configuredBaseUrl } from '@/lib/http/base-url';
import { PUBLIC_ORIGIN } from '@/lib/site/origin';
import { LibraryExpertPanel } from '@/components/dashboard/library-expert';
import { LibraryTabs } from '@/components/dashboard/library-tabs';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { quoteBuild } from '@/lib/application/plans';
import {
  buildFetchesPages,
  isOwnerLifecycleAction,
  ownerActionAvailable,
  OWNER_LIFECYCLE_ACTIONS,
  OWNER_REVIEW_STAGE,
  rebuildBlocked,
  reviewPipeline,
} from '@/lib/domain/library';
import { widgetReady } from '@/lib/domain/site-key';
import { getMessages, translations } from '@/lib/i18n/server';
import { deleteWorkspaceLibraryAction } from '../actions';
import {
  addOwnerEvalQuestionAction,
  applyExpertAction,
  createSiteKeyAction,
  declareRightsAction,
  removeOwnerEvalQuestionAction,
  deleteFaqEntryAction,
  editLibraryMetadataAction,
  ownerLifecycleAction,
  rebuildLibraryAction,
  revokeSiteKeyAction,
  saveFaqEntryAction,
  updateParseScopeAction,
  updateSiteKeyAction,
  withdrawExpertAction,
  deleteShowcaseAction,
  draftShowcaseAction,
  enableShowcaseAction,
  showcaseDomainAction,
  showcaseLeadAction,
  showcaseVerbAction,
  updateShowcaseAction,
  uploadShowcaseAssetAction,
} from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.libraryDetail.metaTitle };
}

/** How many leads the library page lists; the export has them all. */
const LEADS_SHOWN = 200;

const PAGER =
  'inline-flex h-[29px] items-center rounded-md border border-line bg-card px-2.5 text-[11px] font-medium text-ink hover:bg-subtle';

/** The list's tile colours, so the delete dialog shows the same tile here. */
const TILE_COLORS = ['#0f9d77', '#5865f2', '#d97706', '#0ea5e9', '#9333ea', '#e11d48'];

function label(dictionary: Record<string, string>, value: string | null): string {
  return (value && dictionary[value]) || value || '—';
}

/**
 * One library, for its owner: whether it can be queried right now, which
 * version is serving, what is queued or failed, and what the reviewer said.
 * The readiness banner is the whole point of the page -- the list can only
 * say "in progress", and this says why and what to do next.
 */
export default async function DashboardLibraryPage({
  params,
  searchParams,
}: {
  params: Promise<{ libraryId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ libraryId }, query] = await Promise.all([params, searchParams]);
  const [session, { locale, t }] = await Promise.all([
    requireSession(`/dashboard/libraries/${libraryId}`),
    translations(),
  ]);
  const library = await workspaceLibraryDetail({ workspaceId: session.workspace.id, libraryId });
  if (!library) notFound();
  /* The owner's self-check questions, beside the platform's (review-visibility-proposal.md 5.2). */
  const evalQuestions = await listLibraryEvalQuestions({ workspaceId: session.workspace.id, libraryId: library.id });
  /* library-build-billing.md 4.1: what a rebuild may cost, shown when the button is pressed. */
  const quote = await quoteBuild({
    workspaceId: session.workspace.id,
    fetchesPages: buildFetchesPages(library.source?.type),
    /* A rebuild replaces this library's bytes, so they are not storage it competes with. */
    libraryId: library.id,
  });
  const currentVersionId = library.versions.find((version) => version.isCurrent)?.id ?? null;
  const docsPage = documentsPage(query.docs);
  const docsSize = documentsPageSize(query.size);
  /* requirement.md 9.4: the website widget's keys ride along with the documents page. */
  /* The widget's history, a page at a time (`?qa=`), newest first. */
  const qaPage = Math.max(1, Math.floor(Number(query.qa) || 1));
  const entitlement = await showcaseEntitlement(session.workspace.id, { fresh: true });
  /* Calls served from the library, a page at a time (`?usage=`), newest first. */
  const usagePage = Math.max(1, Math.floor(Number(query.usage) || 1));
  const [documents, siteKeys, expert, exchanges, exchangeStats, faqGroups, faqEntries, showcase, showcaseFigures, showcaseCount, showcaseLeads, siteKeyCap, siteKeyCount, usage] = await Promise.all([
    currentVersionId
      ? listVersionDocuments({
          libraryId: library.id,
          versionId: currentVersionId,
          limit: docsSize,
          offset: (docsPage - 1) * docsSize,
        })
      : { documents: [], total: 0 },
    listSiteKeys({ workspaceId: session.workspace.id, libraryId: library.id }),
    /* expert-library-prd.md 5: where the library stands on the expert tag. */
    expertPanel({ workspaceId: session.workspace.id, libraryId: library.id }),
    listWidgetExchanges({
      workspaceId: session.workspace.id,
      libraryId: library.id,
      limit: EXCHANGE_PAGE_SIZE,
      offset: (qaPage - 1) * EXCHANGE_PAGE_SIZE,
    }),
    widgetExchangeStats({ workspaceId: session.workspace.id, libraryId: library.id }),
    listFaqGroups({ workspaceId: session.workspace.id, libraryId: library.id }).catch((): never[] => []),
    listFaqEntries({ workspaceId: session.workspace.id, libraryId: library.id }),
    /* The library shared as a page (lib/domain/showcase.ts). */
    libraryShowcase({ workspaceId: session.workspace.id, libraryId: library.id }, entitlement),
    showcaseStats({ workspaceId: session.workspace.id, libraryId: library.id }),
    countWorkspaceShowcases(session.workspace.id),
    listShowcaseLeads({ workspaceId: session.workspace.id, libraryId: library.id, retained: entitlement.leadsRetained, limit: LEADS_SHOWN }),
    siteKeyEntitlement(session.workspace.id),
    countWorkspaceSiteKeys(session.workspace.id),
    libraryUsageLog({ workspaceId: session.workspace.id, libraryId: library.id, page: usagePage }),
  ]);
  const usagePages = Math.max(1, Math.ceil(usage.total / LIBRARY_USAGE_PAGE_SIZE));
  const usageHref = (page: number) => `/dashboard/libraries/${library.id}?usage=${page}#usage`;
  const showcaseOrigin = configuredBaseUrl() ?? PUBLIC_ORIGIN;
  const showcaseQr = showcase ? await qrCodeSvg(`${showcaseOrigin}${showcasePath(showcase.slug)}`) : null;
  const qaPages = Math.max(1, Math.ceil(exchanges.total / EXCHANGE_PAGE_SIZE));
  const qaHref = (page: number) => `/dashboard/libraries/${library.id}?qa=${page}#exchanges`;
  const docsPages = Math.max(1, Math.ceil(documents.total / docsSize));
  const docsHref = (page: number, size: number = docsSize) =>
    `/dashboard/libraries/${library.id}?docs=${page}&size=${size}#documents`;

  const d = t.dashboard.libraryDetail;
  const l = t.dashboard.libraries;
  const number = new Intl.NumberFormat(locale);
  const stamp = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const when = (value: string | null) => (value ? stamp.format(new Date(value)) : d.stats.never);
  const canEdit = canManageLibraries(session.workspace.role);
  /* The page's own host (lib/application/showcase/domain.ts): read only; a check is the owner's click. */
  const showcaseDomain = showcase ? await showcaseDomainFor({ workspaceId: session.workspace.id, libraryId: library.id }, entitlement) : null;
  const m = d.manage;
  const latestNote = library.reviews.find((review) => review.feedback[0])?.feedback[0] ?? d.basics.none;
  const lastFailure = library.operations.find((operation) => operation.status === 'failed');
  const routable = library.visibility === 'public' && library.queryable;
  /* requirement.md 5.2: pause and resume are the owner's, each offered only
     when the domain rule says it applies right now. */
  const ownerContext = {
    lifecycleStatus: library.lifecycleStatus,
    visibility: library.visibility,
    pausedByOwner: library.pausedByOwner,
  };
  const headerVerbs = canEdit
    ? OWNER_LIFECYCLE_ACTIONS.filter((verb) => ownerActionAvailable(ownerContext, verb))
    : [];
  const inPipeline =
    library.visibility === 'public' && !library.queryable && library.lifecycleStatus !== 'archived';
  const pipeline = inPipeline
    ? reviewPipeline({
        visibility: library.visibility,
        lifecycleStatus: library.lifecycleStatus,
        indexStatus: library.indexStatus,
        building: library.building,
        rightsDeclared: library.materials.rights !== null && rightsAllowPublic(library.materials.rights),
      })
    : null;
  const tile = TILE_COLORS[[...library.publicId].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % TILE_COLORS.length]!;

  /* The banner: one sentence about where the library is, in priority order. */
  const banner = library.queryable
    ? { tone: 'live' as StatusTone, icon: <BadgeCheckIcon size={18} />, title: d.ready.title, body: fill(d.ready.body, { label: library.currentVersion?.label ?? '' }) }
    : library.building
      ? {
          tone: 'pending' as StatusTone,
          icon: <RefreshIcon size={18} />,
          title: d.ready.buildingTitle,
          /* Where it is, from the build's own reports, once there are any. */
          body: [d.ready.buildingBody, describeBuild(t.admin.refreshQueue, library.build)].filter(Boolean).join(' '),
        }
      : library.lifecycleStatus === 'suspended'
        ? { tone: 'blocked' as StatusTone, icon: <LockIcon size={18} />, title: d.ready.suspendedTitle, body: fill(d.ready.suspendedBody, { note: latestNote }) }
        : library.indexStatus === 'failed' && lastFailure
          ? { tone: 'blocked' as StatusTone, icon: <ClockIcon size={18} />, title: d.ready.failedTitle, body: fill(d.ready.failedBody, { error: label(t.admin.ingestionErrors, lastFailure.error) }) }
          : { tone: 'exempt' as StatusTone, icon: <ClockIcon size={18} />, title: d.ready.idleTitle, body: d.ready.idleBody };

  const statusLabels: Record<StatusTone, string> = {
    live: l.statuses.live,
    pending: l.statuses.pending,
    blocked: l.statuses.blocked,
    exempt: l.statuses.exempt,
  };

  return (
    <div className="flex flex-col gap-4">
      <LiveRefresh active={library.building} />
      <header className="flex flex-wrap items-start justify-between gap-5">
        <div className="flex min-w-0 flex-col gap-[5px]">
          <BackLink href="/dashboard/libraries">{d.back}</BackLink>
          <h1 className="mt-1.5 truncate text-[25px] leading-[1.5] font-medium text-ink">
            {library.title}
          </h1>
          <p className="flex flex-wrap items-center gap-2 text-[13px] leading-[1.5] text-muted">
            <span>{library.publicId}</span>
            <Badge tone={library.visibility === 'public' ? 'public' : 'private'}>
              {library.visibility === 'public' ? l.scopePublic : l.scopePrivate}
            </Badge>
            <Badge tone="neutral">{label(d.lifecycle, library.lifecycleStatus)}</Badge>
            {expert?.taggedAt ? <Badge tone="brand">{d.expert.badge}</Badge> : null}
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {routable ? (
            <Link
              href={`/libraries${library.publicId}`}
              className="inline-flex h-[35px] items-center gap-1.5 rounded-md border border-line bg-card px-3 text-[12px] font-medium text-ink hover:bg-subtle"
            >
              {d.actions.publicPage}
              <ArrowRightIcon size={14} />
            </Link>
          ) : null}
          {library.source && library.source.fileCount !== null ? (
            <Link
              href={`/dashboard/libraries/${library.id}/files`}
              className="inline-flex h-[35px] items-center gap-1.5 rounded-md border border-line bg-card px-3 text-[12px] font-medium text-ink hover:bg-subtle"
            >
              <FileTextIcon size={14} />
              {library.source.type === 'markdown' ? l.manage.filesMarkdown : d.actions.files}
            </Link>
          ) : null}
          {headerVerbs.map((verb) => (
            <OwnerActionButton
              key={verb}
              libraryId={library.id}
              publicId={library.publicId}
              action={ownerLifecycleAction}
              verb={verb}
            />
          ))}
          {canEdit ? (
            <RebuildLibraryButton
              libraryId={library.id}
              action={rebuildLibraryAction}
              quote={quote}
              /* Affordability is said inside the confirmation, with the price; only
                 an archived library has no rebuild at all. */
              disabled={rebuildBlocked({ lifecycleStatus: library.lifecycleStatus, affordable: undefined })}
            />
          ) : null}
          {canEdit && library.lifecycleStatus !== 'archived' ? (
            <DetailDeleteControl
              action={deleteWorkspaceLibraryAction}
              target={{
                id: library.id,
                publicId: library.publicId,
                title: library.title,
                initial: (library.title.trim()[0] ?? '?').toUpperCase(),
                color: tile,
              }}
            />
          ) : null}
        </div>
      </header>

      {!canEdit ? (
        <p className="rounded-md border border-line bg-subtle px-3.5 py-2.5 text-[11px] text-muted">
          {m.readOnly}
        </p>
      ) : null}
      {canEdit && library.lifecycleStatus === 'suspended' && !library.pausedByOwner ? (
        <p className="rounded-md border border-line bg-subtle px-3.5 py-2.5 text-[11px] text-muted">
          {m.pausedByReviewer}
        </p>
      ) : null}

      <section
        className={`flex flex-wrap items-center gap-4 rounded-md border px-[19px] py-4 ${
          banner.tone === 'live' ? 'border-publine bg-brandsoft' : 'border-line bg-card'
        }`}
      >
        <IconTile tone="card">{banner.icon}</IconTile>
        <div className="flex min-w-[220px] flex-1 flex-col gap-1">
          <p className="flex items-center gap-2 text-[13px] leading-[1.4] font-medium text-ink">
            {banner.title}
            <StatusLabel tone={banner.tone}>{statusLabels[banner.tone]}</StatusLabel>
          </p>
          <p className="text-[11px] leading-[1.5] text-muted">{banner.body}</p>
        </div>
      </section>

      {/* requirement.md 5.2: a public library shows its review steps, the
          expected time and the reviewer's feedback. */}
      {/* Laid out like the status banner above it: the icon, then the title
          over the steps, so the two read as one column of where the library is. */}
      {pipeline ? (
        <section className="flex flex-wrap items-start gap-4 rounded-md border border-line bg-card px-[19px] py-4">
          <IconTile tone="card">
            <ShieldCheckIcon size={18} />
          </IconTile>
          <div className="flex min-w-[220px] flex-1 flex-col gap-2.5">
            <p className="text-[13px] leading-[1.4] font-medium text-ink">{l.manage.pipeline.title}</p>
            <ReviewPipeline
              entries={pipeline}
              note={library.lifecycleStatus === 'suspended' ? (library.reviews.find((review) => review.feedback[0])?.feedback[0] ?? null) : null}
            />
          </div>
        </section>
      ) : null}

      {/* The rest of the page, one group at a time (LibraryTabs); the hash picks the group. */}
      <LibraryTabs
        tabs={[
          {
            id: 'overview',
            label: d.tabs.overview,
            anchors: ['basics', 'materials', 'reviews'],
            panel: (
              <>
                {/* Plain one-row readout, not four cards: the banner above already carries
                    the one thing that matters, and cards would compete with it. Stacks to
                    two columns, then one, as the width runs out. */}
                <dl className="grid grid-cols-1 gap-x-10 px-1 sm:grid-cols-2 lg:grid-cols-4 lg:gap-x-6">
                  {[
                    [d.stats.status, label(d.indexStatus, library.indexStatus), <ShieldCheckIcon key="i" size={16} />],
                    [d.stats.version, library.currentVersion?.label ?? d.stats.versionNone, <DatabaseIcon key="i" size={16} />],
                    [
                      d.stats.chunks,
                      `${number.format(library.currentVersion?.documents ?? 0)} / ${number.format(library.currentVersion?.chunks ?? 0)}`,
                      <FileTextIcon key="i" size={16} />,
                    ],
                    [d.stats.lastBuild, when(library.lastSuccessfulRefreshAt), <ClockIcon key="i" size={16} />],
                  ].map(([key, value, icon]) => (
                    <div
                      key={String(key)}
                      className="flex items-center gap-3 border-b border-line/70 py-3.5 sm:[&:nth-last-child(-n+2)]:border-b-0 lg:border-b-0 lg:border-r lg:last:border-r-0"
                    >
                      <span className="text-brandink">{icon}</span>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <dt className="text-[11px] text-muted">{key}</dt>
                        <dd className="truncate text-[15px] font-medium text-ink">{value}</dd>
                      </span>
                    </div>
                  ))}
                </dl>

                <section className={`${PANEL} p-6`}>
                  <h2 className="text-[15px] font-medium text-ink">{d.basics.title}</h2>
                  <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 text-[12px] sm:grid-cols-2">
                    {[
                      [d.basics.publicId, library.publicId],
                      [d.basics.visibility, library.visibility === 'public' ? l.scopePublic : l.scopePrivate],
                      [
                        d.basics.source,
                        library.source
                          ? library.source.fileCount === null
                            ? `${library.source.type} · ${library.source.location}`
                            : `${library.source.type} · ${fill(d.basics.files, { n: String(library.source.fileCount) })}`
                          : d.basics.none,
                      ],
                      [d.basics.language, library.language ?? d.basics.none],
                      [d.basics.indexStatus, label(d.indexStatus, library.indexStatus)],
                      [d.basics.created, when(library.createdAt)],
                      [d.basics.description, library.description ?? d.basics.none],
                    ].map(([key, value]) => (
                      <div key={key} className="flex flex-col gap-0.5 border-b border-line/70 py-2 last:border-b-0">
                        <dt className="text-[10px] font-medium tracking-[0.02em] text-muted">{key}</dt>
                        <dd className="break-all text-ink">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>

                {/* The owner's declaration and question set (review-visibility-proposal.md 5):
                    the rights a public library carries, and the questions an expert application
                    is judged by. Shown for a private library too, so declaring happens before it
                    goes public. */}
                {library.lifecycleStatus !== 'archived' ? (
                  <LibraryMaterialsPanel
                    libraryId={library.id}
                    visibility={library.visibility}
                    canEdit={canEdit}
                    materials={library.materials}
                    questions={evalQuestions}
                    actions={{ declare: declareRightsAction, add: addOwnerEvalQuestionAction, remove: removeOwnerEvalQuestionAction }}
                  />
                ) : null}
                {library.visibility === 'public' || library.reviews.length > 0 ? (
                  <section className={`${PANEL} p-0.5`}>
                    <div className="px-6 py-4">
                      <h2 className="text-[15px] font-medium text-ink">{d.reviews.title}</h2>
                    </div>
                    <Table
                      columns={d.reviews.columns}
                      empty={d.reviews.empty}
                      rows={library.reviews.map((review) => [
                        when(review.decidedAt),
                        review.stage === OWNER_REVIEW_STAGE && isOwnerLifecycleAction(review.outcome)
                          ? m.outcomes[review.outcome]
                          : `${label(d.reviews.outcomes, review.outcome)}${review.stage !== 'manual' && review.stage !== OWNER_REVIEW_STAGE ? ` · ${label(d.reviews.stages, review.stage)}` : ''}`,
                        review.feedback.map((line) => describeReviewNote(line, l.rulesReasons)).join(' ') || d.basics.none,
                      ])}
                    />
                  </section>
                ) : null}
                </>
            ),
          },
          {
            id: 'content',
            label: d.tabs.content,
            anchors: ['queue', 'documents', 'versions'],
            panel: (
              <>
                <section className={`${PANEL} p-0.5`}>
                  <div className="px-6 py-4">
                    <h2 className="text-[15px] font-medium text-ink">{d.queue.title}</h2>
                    <p className="mt-0.5 text-[11px] text-muted">{d.queue.description}</p>
                  </div>
                  <Table
                    columns={d.queue.columns}
                    empty={d.queue.empty}
                    rows={library.operations.map((operation) => [
                      label(d.queue.types, operation.operationType),
                      <StatusLabel
                        key="s"
                        tone={
                          operation.status === 'succeeded' || operation.status === 'skipped'
                            ? 'live'
                            : operation.status === 'failed'
                              ? 'blocked'
                              : operation.status === 'cancelled'
                                ? 'exempt'
                                : 'pending'
                        }
                      >
                        {label(d.queue.statuses, operation.status)}
                      </StatusLabel>,
                      String(operation.attempts),
                      operation.error ? label(t.admin.ingestionErrors, operation.error) : d.basics.none,
                      when(operation.createdAt),
                    ])}
                  />
                </section>
                <section id="documents" className={`${PANEL} scroll-mt-4 p-0.5`}>
                  <div className="px-6 py-4">
                    <h2 className="text-[15px] font-medium text-ink">{d.documents.title}</h2>
                    <p className="mt-0.5 text-[11px] text-muted">{d.documents.description}</p>
                  </div>
                  <Table
                    columns={d.documents.columns}
                    empty={d.documents.empty}
                    rows={documents.documents.map((document) => [
                      <Link
                        key="t"
                        href={`/dashboard/libraries/${library.id}/documents/${document.id}`}
                        className="text-brandink hover:text-brandink"
                      >
                        {document.title}
                      </Link>,
                      <a
                        key="u"
                        href={document.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="break-all text-muted hover:text-ink"
                      >
                        {document.sourceUrl}
                      </a>,
                      number.format(document.chunks),
                    ])}
                  />
                  {documents.total > 0 ? (
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-6 py-3">
                      <p className="text-[11px] text-muted">
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
                              className={`rounded-md px-1.5 py-0.5 ${
                                size === docsSize ? 'bg-subtle font-medium text-ink' : 'hover:text-ink'
                              }`}
                            >
                              {size}
                            </Link>
                          ))}
                        </span>
                        {docsPage > 1 ? (
                          <Link href={docsHref(docsPage - 1)} className={PAGER}>
                            {d.documents.prev}
                          </Link>
                        ) : null}
                        {docsPage < docsPages ? (
                          <Link href={docsHref(docsPage + 1)} className={PAGER}>
                            {d.documents.next}
                          </Link>
                        ) : null}
                      </span>
                    </div>
                  ) : null}
                </section>
                <section className={`${PANEL} p-0.5`}>
                  <div className="px-6 py-4">
                    <h2 className="text-[15px] font-medium text-ink">{d.versions.title}</h2>
                  </div>
                  <Table
                    columns={d.versions.columns}
                    empty={d.versions.empty}
                    rows={library.versions.map((version) => [
                      <span key="v" className="flex items-center gap-2">
                        {version.label}
                        {version.isCurrent ? <Badge tone="brand">{d.versions.current}</Badge> : null}
                      </span>,
                      label(d.indexStatus, version.indexStatus),
                      `${number.format(version.documents)} / ${number.format(version.chunks)}`,
                      version.buildCalls === null
                        ? d.versions.costFree
                        : fill(d.versions.cost, { calls: number.format(version.buildCalls) }),
                      when(version.publishedAt),
                    ])}
                  />
                </section>
                </>
            ),
          },
          {
            id: 'widget',
            label: d.widget.title,
            panel:
              library.lifecycleStatus !== 'archived' ? (
                <LibraryWidgetPanel
                  libraryId={library.id}
                  keys={siteKeys}
                  ready={widgetReady({
                    lifecycleStatus: library.lifecycleStatus,
                    hasCurrentVersion: library.currentVersion !== null,
                  })}
                  canEdit={canEdit}
                  maxKeys={SITE_KEYS_PER_LIBRARY}
                  planAllowed={siteKeysAllowed(siteKeyCap, siteKeyCount)}
                  createAction={createSiteKeyAction}
                  updateAction={updateSiteKeyAction}
                  revokeAction={revokeSiteKeyAction}
                />
              ) : null,
          },
          {
            id: 'showcase',
            label: d.showcase.title,
            panel:
              library.lifecycleStatus !== 'archived' ? (
                <LibraryShowcasePanel
                  libraryId={library.id}
                  showcase={showcase}
                  stats={showcaseFigures}
                  leads={showcaseLeads}
                  domain={{ available: customDomainsAvailable(), allowed: entitlement.customDomain, view: showcaseDomain }}
                  origin={showcaseOrigin}
                  qrSvg={showcaseQr}
                  ready={widgetReady({
                    lifecycleStatus: library.lifecycleStatus,
                    hasCurrentVersion: library.currentVersion !== null,
                  })}
                  canEdit={canEdit}
                  allowed={showcasePagesAllowed(entitlement, showcaseCount)}
                  actions={{
                    enable: enableShowcaseAction,
                    update: updateShowcaseAction,
                    draft: draftShowcaseAction,
                    verb: showcaseVerbAction,
                    remove: deleteShowcaseAction,
                    asset: uploadShowcaseAssetAction,
                    lead: showcaseLeadAction,
                    domain: showcaseDomainAction,
                  }}
                />
              ) : null,
          },
          {
            id: 'qa',
            label: d.tabs.qa,
            anchors: ['faq', 'exchanges'],
            panel:
              library.lifecycleStatus !== 'archived' &&
              (siteKeys.length > 0 || faqEntries.length > 0 || faqGroups.length > 0 || showcase !== null || exchanges.total > 0) ? (
                <>
                {/* lib/domain/faq.ts: the recurring questions, and the entries written from them. */}
                {siteKeys.length > 0 || faqEntries.length > 0 || faqGroups.length > 0 ? (
                  <LibraryFaqPanel
                    libraryId={library.id}
                    groups={faqGroups}
                    entries={faqEntries}
                    canEdit={canEdit}
                    saveAction={saveFaqEntryAction}
                    deleteAction={deleteFaqEntryAction}
                  />
                ) : null}
                {/* requirement.md 9.4: what the widget was asked, for the owner to grow the library from. */}
                {siteKeys.length > 0 || showcase !== null || exchanges.total > 0 ? (
                  <section id="exchanges" className={`${PANEL} scroll-mt-4 p-0.5`}>
                    <div className="flex flex-wrap items-start justify-between gap-3 px-6 py-4">
                      <div>
                        <h2 className="text-[15px] font-medium text-ink">{d.exchanges.title}</h2>
                        <p className="mt-0.5 text-[11px] text-muted">{d.exchanges.description}</p>
                      </div>
                      <p className="text-[11px] text-muted">
                        {fill(d.exchanges.stats, {
                          days: exchangeStats.days,
                          questions: number.format(exchangeStats.questions),
                          answered: number.format(exchangeStats.answered),
                          missed: number.format(exchangeStats.missed),
                        })}
                      </p>
                    </div>
                    <Table
                      columns={d.exchanges.columns}
                      empty={d.exchanges.empty}
                      rows={exchanges.exchanges.map((exchange) => [
                        <span key="q" className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-ink" title={exchange.answer ?? undefined}>
                            {exchange.question}
                            {exchange.preview ? (
                              <span className="ml-1.5 rounded bg-mutedbg px-1 py-0.5 text-[10px] text-steel">{d.exchanges.preview}</span>
                            ) : null}
                            {exchange.showcase ? (
                              <span className="ml-1.5 rounded bg-brandsoft px-1 py-0.5 text-[10px] text-brandink">{d.exchanges.showcase}</span>
                            ) : null}
                          </span>
                          {exchange.rewrittenQuery ? (
                            <span className="text-[10.5px] text-muted">
                              {fill(d.exchanges.rewritten, { query: exchange.rewrittenQuery })}
                            </span>
                          ) : null}
                        </span>,
                        <span
                          key="o"
                          className={
                            exchange.outcome === 'answer' || exchange.outcome === 'degraded' ? 'text-steel' : 'text-amber'
                          }
                        >
                          {label(d.exchanges.outcomes, exchange.outcome)}
                        </span>,
                        <span key="s" className="flex flex-col gap-0.5">
                          {exchange.sources.slice(0, 3).map((source) => (
                            <a
                              key={source.url}
                              href={source.url}
                              target="_blank"
                              rel="noreferrer"
                              className="truncate text-brandink hover:text-brandink"
                              title={source.url}
                            >
                              {source.title}
                            </a>
                          ))}
                          {exchange.sources.length === 0 ? <span className="text-muted">{d.basics.none}</span> : null}
                        </span>,
                        <span key="g" className="break-all text-muted">{exchange.origin}</span>,
                        when(exchange.createdAt),
                      ])}
                    />
                    {exchanges.total > EXCHANGE_PAGE_SIZE ? (
                      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-6 py-3">
                        <p className="text-[11px] text-muted">
                          {fill(d.exchanges.page, { page: qaPage, pages: qaPages, total: number.format(exchanges.total) })}
                        </p>
                        <span className="flex items-center gap-2">
                          {qaPage > 1 ? (
                            <Link href={qaHref(qaPage - 1)} className={PAGER}>
                              {d.documents.prev}
                            </Link>
                          ) : null}
                          {qaPage < qaPages ? (
                            <Link href={qaHref(qaPage + 1)} className={PAGER}>
                              {d.documents.next}
                            </Link>
                          ) : null}
                        </span>
                      </div>
                    ) : null}
                  </section>
                ) : null}
                </>
              ) : null,
          },
          {
            id: 'usage',
            label: d.tabs.usage,
            panel: (
              /* Every served call, whoever made it -- the count billing and revenue share see. */
              <section id="usage" className={`${PANEL} scroll-mt-4 p-0.5`}>
                <div className="flex flex-wrap items-start justify-between gap-3 px-6 py-4">
                  <div>
                    <h2 className="text-[15px] font-medium text-ink">{d.usage.title}</h2>
                    <p className="mt-0.5 text-[11px] text-muted">{d.usage.description}</p>
                  </div>
                </div>
                <dl className="grid grid-cols-2 gap-3 px-6 pb-4 sm:grid-cols-4">
                  {[
                    [d.usage.stats.total, usage.summary.total],
                    [d.usage.stats.thisMonth, usage.summary.thisMonth],
                    [d.usage.stats.readers, usage.summary.readersThisMonth],
                    [d.usage.stats.earned, usage.summary.earnedThisMonth],
                  ].map(([key, value]) => (
                    <div key={String(key)} className="flex flex-col gap-0.5">
                      <dt className="text-[11px] text-muted">{key}</dt>
                      <dd className="text-[17px] leading-[1.4] font-medium text-ink">
                        {number.format(Number(value))}
                      </dd>
                    </div>
                  ))}
                </dl>
                {usage.entries.some((entry) => entry.earning === 'none') ? (
                  <p className="border-t border-line px-6 py-3 text-[11px] leading-[1.6] text-muted">{d.usage.whyNot}</p>
                ) : null}
                <Table
                  columns={d.usage.columns}
                  empty={d.usage.empty}
                  rows={usage.entries.map((entry) => [
                    <span key="t" className="whitespace-nowrap text-steel">{when(entry.createdAt)}</span>,
                    <span key="c" className="flex flex-col gap-0.5">
                      <span>{d.usage.callers[entry.caller]}</span>
                      <span className="text-[10.5px] text-muted">
                        {label(d.usage.entrypoints, entry.entrypoint)} · {label(d.usage.operations, entry.operation)}
                      </span>
                    </span>,
                    <span key="v" className="font-mono text-[11px] text-steel">{entry.versionLabel ?? '—'}</span>,
                    <span key="s" className={entry.statusCode < 400 ? 'text-steel' : 'text-rose'}>
                      {entry.statusCode}
                    </span>,
                    <span key="r" className="whitespace-nowrap text-steel">
                      {entry.returnedTokens === null ? '—' : number.format(entry.returnedTokens)}
                      {entry.latencyMs === null ? null : (
                        <span className="ml-1.5 text-[10.5px] text-muted">{number.format(entry.latencyMs)} ms</span>
                      )}
                    </span>,
                    entry.earning === 'none' ? (
                      <span key="e" className="text-muted">—</span>
                    ) : (
                      <Badge key="e" tone={entry.earning === 'earned' ? 'brand' : 'neutral'}>
                        {d.usage.earning[entry.earning]}
                      </Badge>
                    ),
                  ])}
                />
                {usage.total > LIBRARY_USAGE_PAGE_SIZE ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-6 py-3">
                    <p className="text-[11px] text-muted">
                      {fill(d.usage.page, { page: usagePage, pages: usagePages, total: number.format(usage.total) })}
                    </p>
                    <span className="flex items-center gap-2">
                      {usagePage > 1 ? (
                        <Link href={usageHref(usagePage - 1)} className={PAGER}>
                          {d.documents.prev}
                        </Link>
                      ) : null}
                      {usagePage < usagePages ? (
                        <Link href={usageHref(usagePage + 1)} className={PAGER}>
                          {d.documents.next}
                        </Link>
                      ) : null}
                    </span>
                  </div>
                ) : null}
              </section>
            ),
          },
          {
            id: 'settings',
            label: d.tabs.settings,
            anchors: ['metadata', 'expert'],
            panel:
              library.lifecycleStatus !== 'archived' && (canEdit || expert) ? (
                <>
                {/* requirement.md 5.2: metadata and parse scope are the owner's to
                    edit; the forms post to actions that re-check the role. */}
                {canEdit ? (
                  <>
                    <LibraryMetadataForm
                      libraryId={library.id}
                      initial={{
                        title: library.title,
                        description: library.description,
                        language: library.language,
                        visibility: library.visibility,
                      }}
                      rightsDeclared={library.materials.rights !== null}
                      action={editLibraryMetadataAction}
                    />
                    {library.source ? (
                      <ParseScopeForm
                        libraryId={library.id}
                        sourceType={library.source.type}
                        scope={library.source.scope}
                        refreshPolicy={library.source.refreshPolicy}
                        action={updateParseScopeAction}
                      />
                    ) : null}
                  </>
                ) : null}
                {/* expert-library-prd.md 5: the expert tag. Shown for a private library
                    too: its checklist is how an owner learns what the tag needs. */}
                {expert ? (
                  <LibraryExpertPanel
                    libraryId={library.id}
                    taggedAt={expert.taggedAt?.toISOString() ?? null}
                    checks={expert.checks}
                    evaluation={expert.evaluation}
                    earning={expert.earning}
                    blocker={expert.blocker}
                    reapplyAllowedAt={expert.reapplyAllowedAt?.toISOString() ?? null}
                    pending={
                      expert.pending
                        ? { id: expert.pending.id, createdAt: expert.pending.createdAt.toISOString(), note: expert.pending.note }
                        : null
                    }
                    latest={
                      expert.latest
                        ? {
                            status: expert.latest.status,
                            decisionReason: expert.latest.decisionReason,
                            decidedAt: expert.latest.decidedAt?.toISOString() ?? null,
                            createdAt: expert.latest.createdAt.toISOString(),
                          }
                        : null
                    }
                    history={expert.history.map((row) => ({
                      id: row.id,
                      status: row.status,
                      decisionReason: row.decisionReason,
                      decidedAt: row.decidedAt?.toISOString() ?? null,
                      createdAt: row.createdAt.toISOString(),
                    }))}
                    canEdit={canEdit}
                    applyAction={applyExpertAction}
                    withdrawAction={withdrawExpertAction}
                  />
                ) : null}
                </>
              ) : null,
          },
        ]}
      />
    </div>
  );
}

function Table({
  columns,
  rows,
  empty,
}: {
  columns: readonly string[];
  rows: React.ReactNode[][];
  empty: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-left text-[12px]">
        <thead>
          <tr className="bg-subtle text-[11px] font-medium text-muted">
            {columns.map((column) => (
              <th key={column} scope="col" className="px-6 py-3">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr className="border-t border-line">
              <td colSpan={columns.length} className="px-6 py-8 text-center text-[13px] text-muted">
                {empty}
              </td>
            </tr>
          ) : null}
          {rows.map((cells, index) => (
            <tr key={index} className="border-t border-line">
              {cells.map((cell, column) => (
                <td key={column} className="px-6 py-3 align-middle text-ink">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

