/**
 * Use cases behind the platform-library screens: the list, one library in
 * full, and the four things an operator may do to it.
 *
 * requirement.md 5.3 gives the console four verbs over a library re0
 * publishes itself -- create, refresh, suspend, publish -- and this module is
 * all four, plus the two reads the screens need, plus the one verb the
 * requirement leaves to architecture.md 8.4: delete.
 *
 * What is real here and what is not, stated once so no screen has to guess:
 *
 * - creating writes a `library` row and its `source` row, in one transaction.
 *   That is complete; nothing about it waits on ingestion.
 * - refreshing creates a Refresh Operation and returns. architecture.md 8.4 is
 *   explicit that the caller does not wait for execution, so enqueueing *is*
 *   the whole of this side. `lib/application/ingestion` drains the queue -- the
 *   console action starts a run after its response and the scheduled workflow
 *   picks up whatever is left -- which is why this reports whether a row was
 *   queued rather than claiming a sync happened.
 * - publishing refuses without a ready version. Publication is the atomic
 *   switch of `current_version_id` onto an indexed version (architecture.md
 *   8.3); with no version there is nothing to point at, and a `published` row
 *   whose index is empty would be a library that answers queries with nothing.
 * - suspending is immediate and needs no version: it takes the library out of
 *   circulation, which is a property of the row itself.
 * - deleting is a tombstone plus a queued purge (`lib/application/libraries/
 *   delete`). The row stays for billing history, the Library ID is released,
 *   and the content is removed by the Delete Workflow after the response.
 *
 * Every mutation records the operator, the target, the values before and after,
 * the reason, the result, the time and a summary of the network origin.
 */
import { and, count, desc, eq, gte, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { confirmUploads } from '@/lib/application/libraries/create';
import { markLibraryDeleted } from '@/lib/application/libraries/delete';
import { AppError } from '@/contracts/errors';
import { normalizeReason } from '@/lib/domain/admin';
import type { FetchSummary } from '@/lib/domain/ingestion';
import { uuidv7 } from '@/lib/domain/id';
import {
  draftPlatformLibrary,
  draftPlatformSource,
  editPlatformLibrary,
  isPlatformLibraryType,
  isPlatformSourceType,
  lifecycleActionAvailable,
  mergeUploadedFiles,
  parseUploadManifest,
  PLATFORM_UPLOAD_OWNER,
  uploadedFilesOf,
  type UploadedFile,
  lifecycleTarget,
  PlatformLibraryRefused,
  type PlatformLibraryInput,
  type PlatformLifecycleAction,
  type PlatformLifecycleState,
  type PlatformLibraryType,
  type RefreshPolicy,
  indexDepthOf,
  type IndexDepth,
} from '@/lib/domain/library';
import { PROFILE_VERSION } from '@/lib/domain/profile';
import { rebuildProfile } from '@/lib/application/ingestion/rebuild-profile';
import type { ObjectStore } from '@/lib/infrastructure/objects/store';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { assetKindOf } from '@/lib/domain/asset';
import { PLATFORM_CHANNEL_ID } from '@/lib/domain/channel';
import { exposure } from '@/lib/application/channels/visibility';
import { recordAudit } from './audit';
import { ref } from './column-ref';
import { likePattern } from './like-pattern';

export interface PlatformActor {
  administratorId: string;
  email: string;
  clientAddress?: string | null;
}

/* -------------------------------------------------------------------- list */

export type PlatformStatusFilter = 'all' | PlatformLifecycleState;

export const PLATFORM_STATUS_FILTERS: readonly PlatformStatusFilter[] = [
  'all',
  'published',
  'draft',
  'suspended',
  'archived',
];

export function isPlatformStatusFilter(value: unknown): value is PlatformStatusFilter {
  return (
    typeof value === 'string' && (PLATFORM_STATUS_FILTERS as readonly string[]).includes(value)
  );
}

export interface PlatformLibraryRow {
  id: string;
  publicId: string;
  title: string;
  sourceType: string | null;
  sourceCount: number;
  documents: number;
  storageBytes: number;
  lifecycleStatus: string;
  indexStatus: string;
  lastSyncedAt: Date | null;
  createdAt: Date;
}

/**
 * Only ever true rows: everything below is scoped to the platform's own -- and
 * to the ones that still exist. A deleted library is a tombstone (8.4), kept
 * for billing history and shown on no console screen.
 */
const IS_PLATFORM = and(
  eq(schema.library.isPlatformLibrary, true),
  isNull(schema.library.deletedAt),
)!;

/** The type of the first source, when a library has one. */
const firstSourceType = sql<string | null>`(
  select ${ref(schema.source.type)} from ${schema.source}
  where ${ref(schema.source.libraryId)} = ${ref(schema.library.id)}
  order by ${ref(schema.source.id)} limit 1
)`;

const sourceCount = sql<number>`(
  select count(*)::int from ${schema.source}
  where ${ref(schema.source.libraryId)} = ${ref(schema.library.id)}
)`;

/**
 * Documents in the *current* version, not in every version ever built.
 *
 * `document` rows are per version and versions are immutable, so counting by
 * library would add every superseded build to the figure and the number on
 * screen would grow with each refresh even when the source never changed.
 */
const currentDocuments = sql<number>`(
  select count(*)::int from ${schema.document}
  where ${ref(schema.document.versionId)} = ${ref(schema.library.currentVersionId)}
)`;

export interface PlatformLibraryList {
  rows: PlatformLibraryRow[];
  total: number;
  counts: Record<PlatformStatusFilter, number>;
}

export async function listPlatformLibraries(
  input: {
    query?: string;
    status?: PlatformStatusFilter;
    limit?: number;
    offset?: number;
  } = {},
): Promise<PlatformLibraryList> {
  const database = db();
  const term = input.query?.trim();
  const status = input.status ?? 'all';

  const where = and(
    ...[
      IS_PLATFORM,
      term
        ? or(
            ilike(schema.library.title, likePattern(term)),
            ilike(schema.library.publicId, likePattern(term)),
          )
        : undefined,
      status === 'all' ? undefined : eq(schema.library.lifecycleStatus, status),
    ].filter(Boolean),
  );

  const [rows, [totalRow], statusRows] = await Promise.all([
    database
      .select({
        id: schema.library.id,
        publicId: schema.library.publicId,
        title: schema.library.title,
        storageBytes: schema.library.storageBytes,
        lifecycleStatus: schema.library.lifecycleStatus,
        indexStatus: schema.library.indexStatus,
        lastSyncedAt: schema.library.lastSuccessfulRefreshAt,
        createdAt: schema.library.createdAt,
        sourceType: firstSourceType,
        sourceCount,
        documents: currentDocuments,
      })
      .from(schema.library)
      .where(where)
      .orderBy(desc(schema.library.createdAt))
      .limit(input.limit ?? 50)
      .offset(input.offset ?? 0),
    database.select({ n: count() }).from(schema.library).where(where),
    database
      .select({ status: schema.library.lifecycleStatus, n: count() })
      .from(schema.library)
      .where(IS_PLATFORM)
      .groupBy(schema.library.lifecycleStatus),
  ]);

  const byStatus = new Map<string, number>(statusRows.map((row) => [row.status, row.n]));

  return {
    rows,
    total: totalRow?.n ?? 0,
    counts: {
      all: [...byStatus.values()].reduce((a, b) => a + b, 0),
      published: byStatus.get('published') ?? 0,
      draft: byStatus.get('draft') ?? 0,
      suspended: byStatus.get('suspended') ?? 0,
      archived: byStatus.get('archived') ?? 0,
    },
  };
}

export interface PlatformLibrarySummary {
  published: number;
  /** Libraries whose last successful refresh landed today, UTC. */
  syncedToday: number;
  /** Platform libraries with a refresh queued and not yet finished. */
  queuedRefreshes: number;
  /** Retrieval calls against platform libraries this calendar month, UTC. */
  callsThisMonth: number;
}

/**
 * The three figures above the list, plus the queue depth.
 *
 * `callsThisMonth` comes from `usage_event`, which nothing writes yet -- call
 * metering ships with the retrieval path. It reads zero rather than being
 * omitted, and the screen says why, because a metric that disappears when it is
 * zero is a metric nobody notices is broken.
 */
export async function platformLibrarySummary(
  now: Date = new Date(),
): Promise<PlatformLibrarySummary> {
  const database = db();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [[libraryRow], [queueRow], [callRow]] = await Promise.all([
    database
      .select({
        published: sql<number>`(count(*) filter (
          where ${schema.library.lifecycleStatus} = 'published'
        ))::int`,
        syncedToday: sql<number>`(count(*) filter (
          where ${schema.library.lastSuccessfulRefreshAt} >= ${dayStart}
        ))::int`,
      })
      .from(schema.library)
      .where(IS_PLATFORM),
    database
      .select({ n: count() })
      .from(schema.workflowOperation)
      .innerJoin(schema.library, eq(schema.library.id, schema.workflowOperation.libraryId))
      .where(
        and(
          IS_PLATFORM,
          eq(schema.workflowOperation.operationType, REFRESH_OPERATION),
          inArray(schema.workflowOperation.status, [...OPEN_OPERATION_STATUSES]),
        ),
      ),
    database
      .select({ n: count() })
      .from(schema.usageEvent)
      .innerJoin(schema.library, eq(schema.library.id, schema.usageEvent.libraryId))
      .where(and(IS_PLATFORM, gte(schema.usageEvent.createdAt, monthStart))),
  ]);

  return {
    published: libraryRow?.published ?? 0,
    syncedToday: libraryRow?.syncedToday ?? 0,
    queuedRefreshes: queueRow?.n ?? 0,
    callsThisMonth: callRow?.n ?? 0,
  };
}

/* ------------------------------------------------------------------ detail */

export interface PlatformSourceView {
  id: string;
  type: string;
  location: string;
  refreshPolicy: RefreshPolicy | 'unknown';
  /** Website only: nested levels followed; 0 for every other type. */
  indexDepth: IndexDepth;
}

export interface PlatformVersionView {
  id: string;
  label: string;
  indexStatus: string;
  totalChunks: number;
  totalTokens: number;
  documents: number;
  contentMerkleRoot: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  isCurrent: boolean;
}

export interface PlatformOperationView {
  id: string;
  operationType: string;
  /** An operator's button, or the scheduled drain acting on a policy. */
  trigger: string;
  /** The one source it fetches; null for all of them. */
  sourceId: string | null;
  status: string;
  attempts: number;
  error: string | null;
  /** How the build fetched its pages; null before the fetch, or when not applicable. */
  fetchSummary: FetchSummary | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlatformAuditView {
  id: string;
  action: string;
  administrator: string | null;
  reason: string | null;
  result: string;
  createdAt: Date;
}

/**
 * The current version's routing profile, as the console shows it.
 *
 * The profile is what `resolve-library-id` searches instead of the title
 * (architecture.md 9.6), and until now nothing on screen showed it: a crawl
 * that escaped its section, or a term table full of navigation text, could
 * only be found by reading the table. Terms are the head of the list -- the
 * extractor writes them by weight -- so the head is where the noise shows.
 */
export interface PlatformProfileView {
  /** Which extractor wrote the row; stale means a newer one exists. */
  extractorVersion: string;
  stale: boolean;
  titleCount: number;
  /** The first few document titles, as the crawl found them. */
  sampleTitles: string[];
  termCount: number;
  /** The heaviest terms, in the extractor's order. */
  topTerms: string[];
  centroids: number;
  createdAt: Date;
}

export interface PlatformLibraryDetail {
  id: string;
  publicId: string;
  title: string;
  description: string | null;
  domainTag: string | null;
  language: string | null;
  visibility: string;
  lifecycleStatus: PlatformLifecycleState;
  indexStatus: string;
  storageBytes: number;
  currentVersionId: string | null;
  /** Label of the current version, whether or not it is on the page below. */
  currentVersionLabel: string | null;
  lastCheckedAt: Date | null;
  lastSyncedAt: Date | null;
  createdAt: Date;
  /** Of the current version; zero while nothing has been indexed. */
  documents: number;
  chunks: number;
  tokens: number;
  sources: PlatformSourceView[];
  /** The uploads of a `pdf` library, in list order; null when it has no pdf source. */
  files: UploadedFile[] | null;
  versions: PlatformVersionView[];
  operations: PlatformOperationView[];
  audit: PlatformAuditView[];
  /** Whether publishing would be accepted right now. */
  hasReadyVersion: boolean;
  /** Null until a version has been built and profiled. */
  profile: PlatformProfileView | null;
}

/** How much history the detail screen shows. Deeper reading is the audit log. */
const DETAIL_LIMIT = 20;
/** Of the profile: enough to see what the extractor thinks the library is about. */
const PROFILE_TERMS_SHOWN = 40;
const PROFILE_TITLES_SHOWN = 8;

/**
 * One platform library, with everything the four decisions depend on.
 *
 * Returns null for an unknown id, and for a *user* library whose id was pasted
 * into this route: the caller is a page, and both cases should render the
 * console's 404 rather than a screen offering platform verbs over someone
 * else's library.
 */
export async function getPlatformLibrary(libraryId: string): Promise<PlatformLibraryDetail | null> {
  if (!isUuid(libraryId)) return null;

  const database = db();
  const [record] = await database
    .select({
      id: schema.library.id,
      publicId: schema.library.publicId,
      title: schema.library.title,
      description: schema.library.description,
      domainTag: schema.library.domainTag,
      language: schema.library.language,
      visibility: exposure(),
      lifecycleStatus: schema.library.lifecycleStatus,
      indexStatus: schema.library.indexStatus,
      storageBytes: schema.library.storageBytes,
      currentVersionId: schema.library.currentVersionId,
      lastCheckedAt: schema.library.lastCheckedAt,
      lastSyncedAt: schema.library.lastSuccessfulRefreshAt,
      createdAt: schema.library.createdAt,
      isPlatformLibrary: schema.library.isPlatformLibrary,
      deletedAt: schema.library.deletedAt,
    })
    .from(schema.library)
    .where(eq(schema.library.id, libraryId))
    .limit(1);

  /* A deleted one is gone from here too: the 404 says so, the audit log
     says who did it. */
  if (!record || !record.isPlatformLibrary || record.deletedAt) return null;

  const [
    sources,
    versions,
    operations,
    audit,
    [documentRow],
    [current],
    [profileRow],
    [centroidRow],
  ] = await Promise.all([
    database
      .select({
        id: schema.source.id,
        type: schema.source.type,
        location: schema.source.location,
        config: schema.source.config,
        refreshPolicy: schema.source.refreshPolicy,
      })
      .from(schema.source)
      .where(eq(schema.source.libraryId, libraryId))
      .orderBy(schema.source.id),
    database
      .select({
        id: schema.libraryVersion.id,
        label: schema.libraryVersion.label,
        indexStatus: schema.libraryVersion.indexStatus,
        totalChunks: schema.libraryVersion.totalChunks,
        totalTokens: schema.libraryVersion.totalTokens,
        contentMerkleRoot: schema.libraryVersion.contentMerkleRoot,
        publishedAt: schema.libraryVersion.publishedAt,
        createdAt: schema.libraryVersion.createdAt,
        documents: sql<number>`(
          select count(*)::int from ${schema.document}
          where ${ref(schema.document.versionId)} = ${ref(schema.libraryVersion.id)}
        )`,
      })
      .from(schema.libraryVersion)
      .where(eq(schema.libraryVersion.libraryId, libraryId))
      .orderBy(desc(schema.libraryVersion.createdAt))
      .limit(DETAIL_LIMIT),
    database
      .select({
        id: schema.workflowOperation.id,
        operationType: schema.workflowOperation.operationType,
        trigger: schema.workflowOperation.trigger,
        sourceId: schema.workflowOperation.sourceId,
        status: schema.workflowOperation.status,
        attempts: schema.workflowOperation.attempts,
        error: schema.workflowOperation.error,
        fetchSummary: schema.workflowOperation.fetchSummary,
        createdAt: schema.workflowOperation.createdAt,
        updatedAt: schema.workflowOperation.updatedAt,
      })
      .from(schema.workflowOperation)
      .where(eq(schema.workflowOperation.libraryId, libraryId))
      .orderBy(desc(schema.workflowOperation.createdAt))
      .limit(DETAIL_LIMIT),
    database
      .select({
        id: schema.auditLog.id,
        action: schema.auditLog.action,
        reason: schema.auditLog.reason,
        result: schema.auditLog.result,
        createdAt: schema.auditLog.createdAt,
        administrator: schema.administrator.email,
      })
      .from(schema.auditLog)
      .leftJoin(schema.administrator, eq(schema.administrator.id, schema.auditLog.administratorId))
      .where(
        and(eq(schema.auditLog.targetType, AUDIT_TARGET), eq(schema.auditLog.targetId, libraryId)),
      )
      .orderBy(desc(schema.auditLog.seq))
      .limit(DETAIL_LIMIT),
    record.currentVersionId
      ? database
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.document)
          .where(eq(schema.document.versionId, record.currentVersionId))
      : [],
    /*
     * The current version, read by id rather than looked up in `versions`.
     * That list is one page of history, newest first, and the pointer does not
     * have to point at the newest build -- a run of failed rebuilds leaves it
     * on an older, indexed one. Finding it in a truncated page would then
     * report zero chunks and refuse a publication the use case would accept.
     */
    record.currentVersionId
      ? database
          .select({
            label: schema.libraryVersion.label,
            indexStatus: schema.libraryVersion.indexStatus,
            totalChunks: schema.libraryVersion.totalChunks,
            totalTokens: schema.libraryVersion.totalTokens,
          })
          .from(schema.libraryVersion)
          .where(eq(schema.libraryVersion.id, record.currentVersionId))
          .limit(1)
      : [],
    record.currentVersionId
      ? database
          .select({
            profileVersion: schema.libraryProfile.profileVersion,
            documentTitles: schema.libraryProfile.documentTitles,
            terms: schema.libraryProfile.terms,
            createdAt: schema.libraryProfile.createdAt,
          })
          .from(schema.libraryProfile)
          .where(eq(schema.libraryProfile.versionId, record.currentVersionId))
          .limit(1)
      : [],
    record.currentVersionId
      ? database
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.libraryProfileVector)
          .where(eq(schema.libraryProfileVector.versionId, record.currentVersionId))
      : [],
  ]);

  return {
    id: record.id,
    publicId: record.publicId,
    title: record.title,
    description: record.description,
    domainTag: record.domainTag,
    language: record.language,
    visibility: record.visibility,
    lifecycleStatus: record.lifecycleStatus as PlatformLifecycleState,
    indexStatus: record.indexStatus,
    storageBytes: record.storageBytes,
    currentVersionId: record.currentVersionId,
    currentVersionLabel: current?.label ?? null,
    lastCheckedAt: record.lastCheckedAt,
    lastSyncedAt: record.lastSyncedAt,
    createdAt: record.createdAt,
    documents: documentRow?.n ?? 0,
    chunks: current?.totalChunks ?? 0,
    tokens: current?.totalTokens ?? 0,
    sources: sources.map((source) => ({
      id: source.id,
      type: source.type,
      location: source.location,
      refreshPolicy: readRefreshPolicy(source.refreshPolicy),
      indexDepth: indexDepthOf(source.config),
    })),
    versions: versions.map((version) => ({
      ...version,
      isCurrent: version.id === record.currentVersionId,
    })),
    files: (() => {
      const pdf = sources.find((source) => source.type === 'pdf');
      return pdf ? uploadedFilesOf(pdf.config) : null;
    })(),
    operations,
    audit,
    hasReadyVersion: current?.indexStatus === 'ready',
    profile: profileRow
      ? {
          extractorVersion: profileRow.profileVersion,
          stale: profileRow.profileVersion !== PROFILE_VERSION,
          titleCount: profileRow.documentTitles.length,
          sampleTitles: profileRow.documentTitles.slice(0, PROFILE_TITLES_SHOWN),
          termCount: profileRow.terms.length,
          topTerms: profileRow.terms.slice(0, PROFILE_TERMS_SHOWN),
          centroids: centroidRow?.n ?? 0,
          createdAt: profileRow.createdAt,
        }
      : null,
  };
}

/* ---------------------------------------------------------------- profile */

export interface ProfileRebuildResult {
  titles: number;
  terms: number;
}

/**
 * Rebuilds the current version's routing profile from its stored content.
 *
 * Maintenance of derived data (architecture.md 6.4), not a lifecycle verb:
 * nothing about whether the library is served changes. It exists as a console
 * action because the profile can be wrong without the content being wrong --
 * a newer extractor, or one that let navigation text through -- and the
 * alternative was a script only a deployer could run. Audited like every
 * other console mutation.
 */
export async function rebuildPlatformLibraryProfile(input: {
  actor: PlatformActor;
  libraryId: string;
  reason: string;
}): Promise<ProfileRebuildResult> {
  const reason = normalizeReason(input.reason);
  const database = db();
  const target = await loadTarget(database, input.libraryId);
  if (!target.currentVersionId) {
    throw new PlatformLibraryRefused('no_version', 'nothing has been built to profile');
  }

  const result = await rebuildProfile(target.currentVersionId);

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'platform_library.profile_rebuild',
    targetType: AUDIT_TARGET,
    targetId: target.id,
    reason,
    beforeValue: {
      publicId: target.publicId,
      versionId: target.currentVersionId,
    },
    afterValue: {
      publicId: target.publicId,
      versionId: target.currentVersionId,
      ...result,
    },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return result;
}

/**
 * `source.refresh_policy` is free-form JSON, so what comes back is checked
 * rather than trusted: a row written by some future importer must not make the
 * console render `[object Object]` where a cadence should be.
 */
function readRefreshPolicy(stored: Record<string, unknown> | null): RefreshPolicy | 'unknown' {
  const value = stored?.cadence;
  return value === 'daily' || value === 'weekly' || value === 'manual' ? value : 'unknown';
}

/* ------------------------------------------------------------------ create */

export interface CreatePlatformLibraryResult {
  /** The first build, queued when a pdf library was created with files; null otherwise. */
  operationId: string | null;
  libraryId: string;
  publicId: string;
}

/**
 * Creates one platform library and its first source.
 *
 * The row is deliberately born `draft`/`pending` rather than published: nothing
 * has been fetched, so there is no version to serve and `isQueryable` would be
 * false whatever this wrote. It joins the platform's public channel from the
 * start because that is what a platform library is for -- it is the
 * lifecycle, not the channel,
 * that keeps it out of the catalogue until it is ready (requirement.md 6.2
 * keeps the two independent, and this is exactly the case that needs them to
 * be).
 *
 * `owner_workspace_id` is left null and never written here. architecture.md 5.4
 * allows exactly two writers of that column -- a verified claim and an admin
 * ruling -- and a platform library is neither.
 */
export async function createPlatformLibrary(
  input: PlatformLibraryInput & {
    actor: PlatformActor;
    reason: string;
    /** The store the uploads are confirmed in; the configured one by default. */
    store?: Pick<ObjectStore, 'head'>;
  },
): Promise<CreatePlatformLibraryResult> {
  const draft = draftPlatformLibrary(input);
  const reason = normalizeReason(input.reason);
  const database = db();

  /* A pdf library's files are confirmed present at their declared size
     before any row is written, the same contract the dashboard's wizard is
     held to (`createWorkspaceLibrary`). */
  await confirmPlatformUploads(draft.files, input.store);

  /*
   * Checked before the insert so the operator gets `public_id_taken` rather
   * than a driver error, and checked again by `library_public_id_uq` because
   * two operators can type the same id at the same time. The index is the
   * authority; this read is only what turns its verdict into a usable message.
   */
  const [existing] = await database
    .select({ id: schema.library.id })
    .from(schema.library)
    /* Live rows only: a deleted library released its id (8.4). */
    .where(and(eq(schema.library.publicId, draft.publicId), isNull(schema.library.deletedAt)))
    .limit(1);
  if (existing) {
    throw new PlatformLibraryRefused('public_id_taken', 'that Library ID is already in use');
  }

  /*
   * An id another library redirects from is taken too, same as the rename path
   * below: requirement.md 6.1 keeps a redirect when a slug changes, which only
   * means something if one id has one answer. A new library on top of an alias
   * would leave `library.public_id` and `library_alias.from_public_id` both
   * claiming the id, for two different libraries.
   */
  const [aliased] = await database
    .select({ libraryId: schema.libraryAlias.libraryId })
    .from(schema.libraryAlias)
    .where(eq(schema.libraryAlias.fromPublicId, draft.publicId))
    .limit(1);
  if (aliased) {
    throw new PlatformLibraryRefused('public_id_taken', 'that Library ID is already in use');
  }

  const libraryId = uuidv7();
  const sourceId = uuidv7();
  /* Nothing to build for a pdf library without files; every other type is
     built by the first refresh the operator queues. */
  const operationId = draft.sourceType === 'pdf' && draft.files.length > 0 ? uuidv7() : null;

  try {
    await database.transaction(async (tx) => {
      await tx.insert(schema.library).values({
        id: libraryId,
        publicId: draft.publicId,
        title: draft.title,
        description: draft.description,
        domainTag: draft.domainTag,
        language: draft.language,
        ownerWorkspaceId: null,
        isPlatformLibrary: true,
        kind: assetKindOf(draft.sourceType),
        lifecycleStatus: 'draft',
        indexStatus: 'pending',
      });
      /* A platform asset lives in the platform's own public channel
         (agent-first-proposal.md 3.4); its lifecycle, not the channel, is
         what keeps a draft out of retrieval. */
      await tx.insert(schema.channelAsset).values({
        assetId: libraryId,
        channelId: PLATFORM_CHANNEL_ID,
      });
      await tx.insert(schema.source).values({
        id: sourceId,
        libraryId,
        type: draft.sourceType,
        location: draft.location,
        config:
          draft.sourceType === 'pdf'
            ? { files: draft.files }
            : { indexDepth: draft.indexDepth },
        refreshPolicy: { cadence: draft.refreshPolicy },
      });
      if (operationId) {
        await tx.insert(schema.workflowOperation).values({
          id: operationId,
          libraryId,
          operationType: 'ingest',
          sourceDigest: null,
          status: 'pending',
        });
      }
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PlatformLibraryRefused('public_id_taken', 'that Library ID is already in use');
    }
    throw error;
  }

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'platform_library.create',
    targetType: AUDIT_TARGET,
    targetId: libraryId,
    reason,
    beforeValue: null,
    afterValue: {
      publicId: draft.publicId,
      title: draft.title,
      sourceType: draft.sourceType,
      location: draft.location,
      refreshPolicy: draft.refreshPolicy,
      indexDepth: draft.indexDepth,
      lifecycleStatus: 'draft',
    },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return { libraryId, publicId: draft.publicId, operationId };
}

/* --------------------------------------------------------------- lifecycle */

export interface LifecycleChangeResult {
  status: PlatformLifecycleState;
  publicId: string;
}

/**
 * Publish or suspend one platform library. requirement.md 5.3.
 *
 * Publishing sets `lifecycle_status` and nothing else. It does *not* invent a
 * `current_version_id`: the pointer is switched by the publication transaction
 * that builds the version (architecture.md 8.3), and this refuses outright
 * unless that has already happened, so the console can never produce a
 * published library with an empty index.
 *
 * Suspending leaves the version pointer and the index alone. The library stops
 * answering because `isQueryable` requires `published`; deleting anything would
 * make the pause irreversible, and a pause is not a deletion.
 */
export async function setPlatformLibraryLifecycle(input: {
  actor: PlatformActor;
  libraryId: string;
  action: PlatformLifecycleAction;
  reason: string;
}): Promise<LifecycleChangeResult> {
  const reason = normalizeReason(input.reason);
  const database = db();
  const target = await loadTarget(database, input.libraryId);

  if (!lifecycleActionAvailable(target.lifecycleStatus, input.action)) {
    throw new PlatformLibraryRefused(
      target.lifecycleStatus === 'archived' ? 'archived' : 'invalid_transition',
      `cannot ${input.action} a ${target.lifecycleStatus} library`,
    );
  }

  const next = lifecycleTarget(input.action);

  if (input.action === 'publish') {
    const ready = target.currentVersionId
      ? await database
          .select({ id: schema.libraryVersion.id })
          .from(schema.libraryVersion)
          .where(
            and(
              eq(schema.libraryVersion.id, target.currentVersionId),
              eq(schema.libraryVersion.indexStatus, 'ready'),
            ),
          )
          .limit(1)
      : [];
    if (ready.length === 0) {
      throw new PlatformLibraryRefused(
        'no_ready_version',
        'publication requires an indexed current version',
      );
    }
  }

  /*
   * Guarded on the status it was read at, so two operators acting on the same
   * library at the same time cannot both succeed. The loser's update matches no
   * row and is reported as an invalid transition, which is what it now is.
   */
  const updated = await database
    .update(schema.library)
    .set({ lifecycleStatus: next })
    .where(
      and(
        eq(schema.library.id, target.id),
        eq(schema.library.lifecycleStatus, target.lifecycleStatus),
        IS_PLATFORM,
      ),
    )
    .returning({ id: schema.library.id });

  if (updated.length === 0) {
    throw new PlatformLibraryRefused('invalid_transition', 'the library moved while you decided');
  }

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: input.action === 'publish' ? 'platform_library.publish' : 'platform_library.suspend',
    targetType: AUDIT_TARGET,
    targetId: target.id,
    reason,
    beforeValue: {
      publicId: target.publicId,
      lifecycleStatus: target.lifecycleStatus,
    },
    afterValue: { publicId: target.publicId, lifecycleStatus: next },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return { status: next, publicId: target.publicId };
}

/* ----------------------------------------------------------------- refresh */

const REFRESH_OPERATION = 'refresh';

/** Operation states that mean the work is still owed. */
const OPEN_OPERATION_STATUSES = ['pending', 'running'] as const;

export interface RefreshRequestResult {
  operationId: string;
  /** False when a refresh was already queued, so the console says so. */
  created: boolean;
}

/**
 * Queues a refresh of one platform library.
 *
 * Idempotent by intent rather than by index: `workflow_operation_uq` covers
 * `(library_id, source_digest, operation_type)`, and a manually requested
 * refresh has no digest yet -- the digest is what the fetch discovers. Postgres
 * treats NULLs as distinct in a unique index, so the constraint would not
 * collapse two of these, and a second click would silently queue the same work
 * twice. Reusing the open row is what makes the button safe to press twice.
 *
 * There is still a race between the read and the insert. It is left as one:
 * losing it queues one duplicate refresh, the worker's own digest check ends it
 * cheaply (architecture.md 8.4 -- an unchanged digest updates `last_checked_at`
 * and stops), and taking a lock here would be a heavier price than the mistake.
 */
export async function requestPlatformLibraryRefresh(input: {
  actor: PlatformActor;
  libraryId: string;
  /** Refresh this one source only; the others are carried forward unfetched. */
  sourceId?: string | null;
  reason: string;
}): Promise<RefreshRequestResult> {
  const reason = normalizeReason(input.reason);
  const database = db();
  const target = await loadTarget(database, input.libraryId);

  if (target.lifecycleStatus === 'archived') {
    throw new PlatformLibraryRefused('archived', 'an archived library is not refreshed');
  }
  const sourceId = input.sourceId ? (await loadSource(database, target.id, input.sourceId)).id : null;

  /*
   * An open refresh of the whole library covers a request for one source; an
   * open refresh of the same source covers a repeat. One of another source
   * does not -- it will not fetch this one -- so a new row is queued behind.
   */
  const open = await database
    .select({ id: schema.workflowOperation.id, sourceId: schema.workflowOperation.sourceId })
    .from(schema.workflowOperation)
    .where(
      and(
        eq(schema.workflowOperation.libraryId, target.id),
        eq(schema.workflowOperation.operationType, REFRESH_OPERATION),
        inArray(schema.workflowOperation.status, [...OPEN_OPERATION_STATUSES]),
      ),
    )
    .orderBy(desc(schema.workflowOperation.createdAt));
  const covering = open.find((row) => row.sourceId === null || row.sourceId === sourceId);
  if (covering) return { operationId: covering.id, created: false };

  const operationId = uuidv7();
  await database.insert(schema.workflowOperation).values({
    id: operationId,
    libraryId: target.id,
    operationType: REFRESH_OPERATION,
    sourceDigest: null,
    sourceId,
    status: 'pending',
  });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'platform_library.refresh',
    targetType: AUDIT_TARGET,
    targetId: target.id,
    reason,
    beforeValue: {
      publicId: target.publicId,
      lastCheckedAt: target.lastCheckedAt,
    },
    afterValue: { publicId: target.publicId, operationId, sourceId, status: 'pending' },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return { operationId, created: true };
}

/* ------------------------------------------------------------------- edit */

/**
 * Edits the fields the catalogue shows.
 *
 * Separate from the lifecycle verbs because it changes what a library *is*
 * rather than whether it is being served, and separate from the source
 * mutations below because a title is not a fetch instruction. A published
 * library can be edited: correcting a description should not require taking it
 * out of the catalogue first.
 *
 * A changed Library ID leaves a redirect behind. requirement.md 6.1 requires
 * one, and the reason is that a Library ID is quoted in agent configuration and
 * in other people's documentation -- a rename with no redirect breaks every one
 * of those quietly, which is worse than refusing the rename.
 */
export async function updatePlatformLibrary(input: {
  actor: PlatformActor;
  libraryId: string;
  title: string;
  publicId: string;
  description?: string;
  domainTag?: string;
  language?: string;
  reason: string;
}): Promise<{ publicId: string; renamed: boolean }> {
  const reason = normalizeReason(input.reason);
  const database = db();
  const target = await loadTarget(database, input.libraryId);

  if (target.lifecycleStatus === 'archived') {
    throw new PlatformLibraryRefused('archived', 'an archived library is not edited');
  }

  const [before] = await database
    .select({
      title: schema.library.title,
      publicId: schema.library.publicId,
      description: schema.library.description,
      domainTag: schema.library.domainTag,
      language: schema.library.language,
    })
    .from(schema.library)
    .where(eq(schema.library.id, target.id))
    .limit(1);

  if (!before) throw new PlatformLibraryRefused('not_found', 'no such library');

  /*
   * The namespace a Library ID may use is decided by the source type
   * (requirement.md 6.1), so the edit is validated against the type this
   * library already has. A library with no source keeps whatever namespace its
   * current id is in, which `sourceTypeOf` recovers from the id itself.
   */
  const sourceType = await sourceTypeOf(database, target.id, before.publicId);
  const edit = editPlatformLibrary({
    sourceType,
    title: input.title,
    publicId: input.publicId,
    description: input.description,
    domainTag: input.domainTag,
    language: input.language,
  });

  const renamed = edit.publicId !== before.publicId;
  if (renamed) {
    const [clash] = await database
      .select({ id: schema.library.id })
      .from(schema.library)
      .where(and(eq(schema.library.publicId, edit.publicId), isNull(schema.library.deletedAt)))
      .limit(1);
    if (clash) {
      throw new PlatformLibraryRefused('public_id_taken', 'that Library ID is already in use');
    }

    /*
     * An id another library redirects from is taken too.
     *
     * requirement.md 6.1 keeps a redirect when a slug changes, which only means
     * something if one id has one answer. Allowing this would leave
     * `library.public_id` and `library_alias.from_public_id` both claiming it,
     * for two different libraries, with nothing to break the tie -- so the
     * check covers both tables. An alias this library left behind itself is not
     * a clash: reclaiming your own old id is how you undo a rename, and the
     * transaction below drops that alias rather than redirecting the id to the
     * library that now holds it.
     */
    const [aliased] = await database
      .select({ libraryId: schema.libraryAlias.libraryId })
      .from(schema.libraryAlias)
      .where(eq(schema.libraryAlias.fromPublicId, edit.publicId))
      .limit(1);
    if (aliased && aliased.libraryId !== target.id) {
      throw new PlatformLibraryRefused('public_id_taken', 'that Library ID is already in use');
    }
  }

  try {
    await database.transaction(async (tx) => {
      await tx
        .update(schema.library)
        .set({
          title: edit.title,
          publicId: edit.publicId,
          description: edit.description,
          domainTag: edit.domainTag,
          language: edit.language,
        })
        .where(and(eq(schema.library.id, target.id), IS_PLATFORM));

      if (renamed) {
        /*
         * A library reclaiming its own old id must not also redirect from it:
         * the row it is moving to is now live, and an alias pointing at the
         * same library would be a redirect from an id to itself.
         */
        await tx
          .delete(schema.libraryAlias)
          .where(eq(schema.libraryAlias.fromPublicId, edit.publicId));

        /*
         * The alias table is keyed on the id being left behind, so a library
         * renamed twice keeps both redirects; `onConflictDoNothing` covers a
         * re-run that finds the redirect already recorded.
         */
        await tx
          .insert(schema.libraryAlias)
          .values({
            id: uuidv7(),
            fromPublicId: before.publicId,
            libraryId: target.id,
          })
          .onConflictDoNothing();
      }
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PlatformLibraryRefused('public_id_taken', 'that Library ID is already in use');
    }
    throw error;
  }

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'platform_library.update',
    targetType: AUDIT_TARGET,
    targetId: target.id,
    reason,
    beforeValue: before,
    afterValue: {
      title: edit.title,
      publicId: edit.publicId,
      description: edit.description,
      domainTag: edit.domainTag,
      language: edit.language,
    },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return { publicId: edit.publicId, renamed };
}

/* ---------------------------------------------------------------- sources */

/**
 * Adds the source to a platform asset that has none.
 *
 * An asset has exactly one source (agent-first-proposal.md 3.1): a project
 * documented in a repository and on a site is two assets now, side by side
 * in the platform channel. What is left of this verb is giving a source back
 * to an asset whose last source was removed; anything else is refused.
 */
export async function addPlatformLibrarySource(input: {
  actor: PlatformActor;
  libraryId: string;
  type: string;
  location: string;
  refreshPolicy: string;
  indexDepth?: unknown;
  /** `pdf` only: the manifest the console posted after uploading. */
  uploads?: unknown;
  reason: string;
  store?: Pick<ObjectStore, 'head'>;
}): Promise<{
  sourceId: string;
  /** The build a pdf source with files queued for itself; null otherwise. */
  operationId: string | null;
}> {
  const reason = normalizeReason(input.reason);
  const draft = draftPlatformSource(input);
  const database = db();
  const target = await loadTarget(database, input.libraryId);

  if (target.lifecycleStatus === 'archived') {
    throw new PlatformLibraryRefused('archived', 'an archived library takes no new sources');
  }
  const [present] = await database
    .select({ id: schema.source.id })
    .from(schema.source)
    .where(eq(schema.source.libraryId, target.id))
    .limit(1);
  if (present) {
    throw new PlatformLibraryRefused('source_exists', 'an asset has exactly one source');
  }

  /*
   * One pdf source per library: the files panel manages "the" pdf source,
   * and two would leave it managing one and hiding the other. A second set
   * of PDFs is added to the existing source from that panel.
   */
  if (draft.type === 'pdf') {
    const [existing] = await database
      .select({ id: schema.source.id })
      .from(schema.source)
      .where(and(eq(schema.source.libraryId, target.id), eq(schema.source.type, 'pdf')))
      .limit(1);
    if (existing) {
      throw new PlatformLibraryRefused('pdf_source_exists', 'this library already has a pdf source');
    }
    await confirmPlatformUploads(draft.files, input.store);
  }

  const sourceId = uuidv7();
  /* A pdf source with files builds itself at once; the other sources are
     carried forward from the current version (build-version.ts). */
  const operationId = draft.type === 'pdf' && draft.files.length > 0 ? uuidv7() : null;
  await database.transaction(async (tx) => {
    await tx.insert(schema.source).values({
      id: sourceId,
      libraryId: target.id,
      type: draft.type,
      location: draft.location,
      config: draft.type === 'pdf' ? { files: draft.files } : { indexDepth: draft.indexDepth },
      refreshPolicy: { cadence: draft.refreshPolicy },
    });
    if (operationId) {
      await tx.insert(schema.workflowOperation).values({
        id: operationId,
        libraryId: target.id,
        operationType: REFRESH_OPERATION,
        sourceDigest: null,
        sourceId,
        status: 'pending',
      });
    }
  });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'platform_library.source_add',
    targetType: AUDIT_TARGET,
    targetId: target.id,
    reason,
    beforeValue: null,
    afterValue: {
      sourceId,
      type: draft.type,
      location: draft.location,
      refreshPolicy: draft.refreshPolicy,
      indexDepth: draft.indexDepth,
      files: draft.files.map((file) => file.name),
      operationId,
    },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return { sourceId, operationId };
}

/**
 * Changes where one source is fetched from, or how often.
 *
 * The type is not editable. A source's type decides which connector reads it
 * and which Library ID namespace the library sits in; changing it in place
 * would leave every version already built from the old type claiming to have
 * come from the new one.
 */
export async function updatePlatformLibrarySource(input: {
  actor: PlatformActor;
  libraryId: string;
  sourceId: string;
  location: string;
  refreshPolicy: string;
  indexDepth?: unknown;
  reason: string;
}): Promise<void> {
  const reason = normalizeReason(input.reason);
  const database = db();
  const target = await loadTarget(database, input.libraryId);

  if (target.lifecycleStatus === 'archived') {
    throw new PlatformLibraryRefused('archived', 'an archived library is not edited');
  }

  const before = await loadSource(database, target.id, input.sourceId);
  /* A pdf source has no location to edit; its files panel is the edit. */
  if (before.type === 'pdf') {
    throw new PlatformLibraryRefused('unsupported_source', 'a pdf source is edited from its files panel');
  }
  const draft = draftPlatformSource({
    type: before.type,
    location: input.location,
    refreshPolicy: input.refreshPolicy,
    indexDepth: input.indexDepth,
  });

  await database
    .update(schema.source)
    .set({
      location: draft.location,
      refreshPolicy: { cadence: draft.refreshPolicy },
      config: { ...before.config, indexDepth: draft.indexDepth },
    })
    .where(and(eq(schema.source.id, before.id), eq(schema.source.libraryId, target.id)));

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'platform_library.source_update',
    targetType: AUDIT_TARGET,
    targetId: target.id,
    reason,
    beforeValue: {
      sourceId: before.id,
      location: before.location,
      refreshPolicy: before.refreshPolicy,
      indexDepth: indexDepthOf(before.config),
    },
    afterValue: {
      sourceId: before.id,
      location: draft.location,
      refreshPolicy: draft.refreshPolicy,
      indexDepth: draft.indexDepth,
    },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });
}

/**
 * Removes a source, unless it is the last one.
 *
 * A library with no source cannot be refreshed and cannot be rebuilt; what it
 * would become is a published index that nothing can ever correct. Deleting the
 * library is a different decision, and one this console does not offer.
 *
 * Versions already built from the removed source are left alone. They are
 * immutable by requirement.md 8.1, and rewriting history to match a decision
 * made today is exactly what immutability is for preventing.
 */
export async function removePlatformLibrarySource(input: {
  actor: PlatformActor;
  libraryId: string;
  sourceId: string;
  reason: string;
}): Promise<void> {
  const reason = normalizeReason(input.reason);
  const database = db();
  const target = await loadTarget(database, input.libraryId);

  /* The same guard the other three source verbs carry. Without it an archived
     library refused an edit to a source while allowing that source's deletion,
     and the deletion was audited as a success. */
  if (target.lifecycleStatus === 'archived') {
    throw new PlatformLibraryRefused('archived', 'an archived library is not edited');
  }

  const before = await loadSource(database, target.id, input.sourceId);

  /*
   * Serialized on the library row, because the two operators are deleting
   * *different* rows.
   *
   * Counting and then deleting is two statements, and under read-committed two
   * removals of the two sources of a two-source library each see two, each pass
   * the guard, and the library is left with none -- unrefreshable, and exactly
   * the state this guard exists to prevent. Row locks on `source` do not help:
   * different rows never block each other. Locking the library they belong to
   * is what makes the pair of statements atomic with respect to each other, and
   * the second one then counts one and is refused.
   */
  const removed = await database.transaction(async (tx) => {
    await tx
      .select({ id: schema.library.id })
      .from(schema.library)
      .where(eq(schema.library.id, target.id))
      .for('update');

    const [remaining] = await tx
      .select({ n: count() })
      .from(schema.source)
      .where(eq(schema.source.libraryId, target.id));

    if ((remaining?.n ?? 0) <= 1) return false;

    const deleted = await tx
      .delete(schema.source)
      .where(and(eq(schema.source.id, before.id), eq(schema.source.libraryId, target.id)))
      .returning({ id: schema.source.id });

    return deleted.length > 0;
  });

  if (!removed) {
    throw new PlatformLibraryRefused('last_source', 'a library keeps at least one source');
  }

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'platform_library.source_remove',
    targetType: AUDIT_TARGET,
    targetId: target.id,
    reason,
    beforeValue: {
      sourceId: before.id,
      type: before.type,
      location: before.location,
    },
    afterValue: null,
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });
}

/* ------------------------------------------------------------------ delete */

export interface UpdatePlatformFilesResult {
  files: UploadedFile[];
  /** The rebuild this edit queued, or found already waiting; null when there is nothing to build. */
  operationId: string | null;
  /** False when the rebuild was already waiting, so the console says so. */
  created: boolean;
}

/**
 * Adds and removes the PDFs of a platform library, then queues its rebuild.
 *
 * The console's counterpart of `updateLibraryFiles` (lib/application/
 * libraries/files.ts), held to the same contract: every added file is a
 * manifest entry under the platform prefix, confirmed present in the store
 * at its declared size, and every removed one is a file the source lists.
 * Removed files' objects stay until the upload sweep finds nothing listing
 * them -- the published version's citations point at them until the rebuild
 * lands.
 */
export async function updatePlatformLibraryFiles(input: {
  actor: PlatformActor;
  libraryId: string;
  /** A manifest of freshly uploaded files, as parsed JSON; absent adds none. */
  add?: unknown;
  /** Ids of listed files to drop. */
  remove?: readonly string[];
  reason: string;
  store?: Pick<ObjectStore, 'head'>;
}): Promise<UpdatePlatformFilesResult> {
  const reason = normalizeReason(input.reason);
  const database = db();
  const target = await loadTarget(database, input.libraryId);
  if (target.lifecycleStatus === 'archived') {
    throw new PlatformLibraryRefused('archived', 'an archived library is not edited');
  }

  const manifest =
    input.add === undefined || input.add === null
      ? { files: [] as UploadedFile[] }
      : parseUploadManifest(input.add, PLATFORM_UPLOAD_OWNER);
  if (!manifest) throw new PlatformLibraryRefused('invalid_uploads', 'the upload manifest is not valid');
  const remove = input.remove ?? [];
  if (remove.some((id) => typeof id !== 'string' || !isUuid(id))) {
    throw new PlatformLibraryRefused('invalid_uploads', 'a file id to remove is not valid');
  }
  if (manifest.files.length === 0 && remove.length === 0) {
    throw new PlatformLibraryRefused('nothing_to_change', 'nothing to change');
  }

  /* Confirmed before the transaction: a store round-trip per file is not
     something to hold a row lock across. */
  await confirmPlatformUploads(manifest.files, input.store);

  const outcome = await database.transaction(async (tx) => {
    const [source] = await tx
      .select({ id: schema.source.id, config: schema.source.config })
      .from(schema.source)
      .where(and(eq(schema.source.libraryId, target.id), eq(schema.source.type, 'pdf')))
      .limit(1)
      .for('update');
    if (!source) {
      throw new PlatformLibraryRefused('unsupported_source', 'this library has no pdf source');
    }
    const before = uploadedFilesOf(source.config);
    const files = mergeUploadedFiles(before, manifest.files, remove);
    if (!files) throw new PlatformLibraryRefused('invalid_uploads', 'the file list is not valid');

    await tx
      .update(schema.source)
      .set({ config: { ...source.config, files } })
      .where(eq(schema.source.id, source.id));

    if (files.length === 0) return { before, files, operationId: null, created: false };

    /* A pending build has not read the source yet and will pick this up; a
       running one already has, so a new row is queued behind it. */
    const [open] = await tx
      .select({ id: schema.workflowOperation.id, status: schema.workflowOperation.status })
      .from(schema.workflowOperation)
      .where(
        and(
          eq(schema.workflowOperation.libraryId, target.id),
          inArray(schema.workflowOperation.operationType, ['ingest', REFRESH_OPERATION]),
          inArray(schema.workflowOperation.status, [...OPEN_OPERATION_STATUSES]),
        ),
      )
      .orderBy(desc(schema.workflowOperation.createdAt))
      .limit(1);
    if (open?.status === 'pending') return { before, files, operationId: open.id, created: false };

    const operationId = uuidv7();
    await tx.insert(schema.workflowOperation).values({
      id: operationId,
      libraryId: target.id,
      operationType: REFRESH_OPERATION,
      sourceDigest: null,
      status: 'pending',
    });
    return { before, files, operationId, created: true };
  });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'platform_library.files',
    targetType: AUDIT_TARGET,
    targetId: target.id,
    reason,
    beforeValue: { publicId: target.publicId, files: outcome.before.map((file) => file.name) },
    afterValue: {
      publicId: target.publicId,
      files: outcome.files.map((file) => file.name),
      operationId: outcome.operationId,
    },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return { files: outcome.files, operationId: outcome.operationId, created: outcome.created };
}

/**
 * `confirmUploads` speaks the API's error vocabulary; the console speaks the
 * platform-library one. A manifest entry the store does not hold is the
 * operator's upload having failed, not a malformed request.
 */
async function confirmPlatformUploads(
  files: UploadedFile[],
  store: Pick<ObjectStore, 'head'> | undefined,
): Promise<void> {
  try {
    await confirmUploads(files, store);
  } catch (error) {
    if (error instanceof AppError && error.code === 'invalid_request') {
      throw new PlatformLibraryRefused('invalid_uploads', error.message);
    }
    if (error instanceof AppError && error.code === 'provider_unavailable') {
      throw new PlatformLibraryRefused('unavailable', error.message);
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ delete */

export interface PlatformDeleteResult {
  libraryId: string;
  publicId: string;
  /** The queued Delete Operation, run after the response and by the drain. */
  operationId: string | null;
}

/**
 * Deletes one platform library. architecture.md 8.4.
 *
 * Available from every state, `archived` included: a library that has been
 * taken out of circulation and will not come back is exactly the one an
 * operator deletes. What the transaction does is in `markLibraryDeleted`; what
 * this adds is the console's contract -- the target is checked to be the
 * platform's own, and the operator, the reason and what the library was are
 * recorded before it stops being anything.
 *
 * The audit entry carries the counts rather than the content: the rows it
 * describes are about to be purged, and the entry is what an operator reads
 * to know how much a deletion removed.
 */
export async function deletePlatformLibrary(input: {
  actor: PlatformActor;
  libraryId: string;
  reason: string;
}): Promise<PlatformDeleteResult> {
  const reason = normalizeReason(input.reason);
  const database = db();
  const target = await loadTarget(database, input.libraryId);

  const [[sources], [versions], [before]] = await Promise.all([
    database
      .select({ n: count() })
      .from(schema.source)
      .where(eq(schema.source.libraryId, target.id)),
    database
      .select({ n: count() })
      .from(schema.libraryVersion)
      .where(eq(schema.libraryVersion.libraryId, target.id)),
    database
      .select({
        title: schema.library.title,
        visibility: exposure(),
        indexStatus: schema.library.indexStatus,
        storageBytes: schema.library.storageBytes,
      })
      .from(schema.library)
      .where(eq(schema.library.id, target.id))
      .limit(1),
  ]);

  const deleted = await markLibraryDeleted(target.id);

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'platform_library.delete',
    targetType: AUDIT_TARGET,
    targetId: target.id,
    reason,
    beforeValue: {
      publicId: target.publicId,
      title: before?.title ?? null,
      visibility: before?.visibility ?? null,
      lifecycleStatus: target.lifecycleStatus,
      indexStatus: before?.indexStatus ?? null,
      currentVersionId: target.currentVersionId,
      storageBytes: before?.storageBytes ?? 0,
      sources: sources?.n ?? 0,
      versions: versions?.n ?? 0,
    },
    afterValue: {
      publicId: target.publicId,
      lifecycleStatus: 'archived',
      indexStatus: 'deleting',
      deleted: true,
      operationId: deleted.operationId,
      alreadyDeleted: deleted.alreadyDeleted,
    },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return {
    libraryId: target.id,
    publicId: target.publicId,
    operationId: deleted.operationId,
  };
}

async function loadSource(
  database: ReturnType<typeof db>,
  libraryId: string,
  sourceId: string,
): Promise<{
  id: string;
  type: string;
  location: string;
  refreshPolicy: RefreshPolicy | 'unknown';
  indexDepth: IndexDepth;
  config: Record<string, unknown>;
}> {
  if (!isUuid(sourceId)) throw new PlatformLibraryRefused('source_not_found', 'no such source');

  const [row] = await database
    .select({
      id: schema.source.id,
      type: schema.source.type,
      location: schema.source.location,
      refreshPolicy: schema.source.refreshPolicy,
      config: schema.source.config,
    })
    .from(schema.source)
    .where(and(eq(schema.source.id, sourceId), eq(schema.source.libraryId, libraryId)))
    .limit(1);

  if (!row) throw new PlatformLibraryRefused('source_not_found', 'no such source');
  return {
    id: row.id,
    type: row.type,
    location: row.location,
    refreshPolicy: readRefreshPolicy(row.refreshPolicy),
    indexDepth: indexDepthOf(row.config),
    config: row.config,
  };
}

/**
 * The source type an edit must validate the Library ID against.
 *
 * Read from the library's first source, and recovered from the id's own
 * namespace when there is none -- a library whose only source was removed by
 * some future path still has an id in a namespace, and refusing to edit its
 * title because of that would be a strange thing to explain.
 */
async function sourceTypeOf(
  database: ReturnType<typeof db>,
  libraryId: string,
  publicId: string,
): Promise<PlatformLibraryType> {
  const [row] = await database
    .select({ type: schema.source.type })
    .from(schema.source)
    .where(eq(schema.source.libraryId, libraryId))
    .orderBy(schema.source.id)
    .limit(1);

  if (row && isPlatformLibraryType(row.type)) return row.type;
  if (publicId.startsWith('/websites/')) return 'website';
  if (publicId.startsWith('/notion/')) return 'notion';
  if (publicId.startsWith('/docs/')) return 'pdf';
  return 'github';
}

/* ------------------------------------------------------------------ shared */

/** `target_type` for every audit entry this module writes. */
const AUDIT_TARGET = 'platform_library';

interface LifecycleTargetRow {
  id: string;
  publicId: string;
  lifecycleStatus: PlatformLifecycleState;
  currentVersionId: string | null;
  lastCheckedAt: Date | null;
}

/**
 * Loads the row a mutation is about, refusing anything that is not this
 * console's to change.
 *
 * `not_platform_library` is separate from `not_found` on purpose: a user
 * library reached through a hand-edited id is a different mistake from a typo,
 * and conflating them would let an operator believe a library they can see in
 * the other list has vanished.
 */
async function loadTarget(
  database: ReturnType<typeof db>,
  libraryId: string,
): Promise<LifecycleTargetRow> {
  if (!isUuid(libraryId)) {
    throw new PlatformLibraryRefused('not_found', 'no such library');
  }
  const [row] = await database
    .select({
      id: schema.library.id,
      publicId: schema.library.publicId,
      lifecycleStatus: schema.library.lifecycleStatus,
      currentVersionId: schema.library.currentVersionId,
      lastCheckedAt: schema.library.lastCheckedAt,
      isPlatformLibrary: schema.library.isPlatformLibrary,
      deletedAt: schema.library.deletedAt,
    })
    .from(schema.library)
    .where(eq(schema.library.id, libraryId))
    .limit(1);

  /* A tombstone is not a target. It is not found, the way the detail page
     already answers, rather than "archived" -- there is nothing to un-archive. */
  if (!row || row.deletedAt) throw new PlatformLibraryRefused('not_found', 'no such library');
  if (!row.isPlatformLibrary) {
    throw new PlatformLibraryRefused('not_platform_library', 'not a platform library');
  }
  return {
    id: row.id,
    publicId: row.publicId,
    lifecycleStatus: row.lifecycleStatus as PlatformLifecycleState,
    currentVersionId: row.currentVersionId,
    lastCheckedAt: row.lastCheckedAt,
  };
}

/** Cheap guard so a junk path segment cannot reach Postgres as a bad uuid cast. */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Postgres `unique_violation`, whatever driver wrapper it arrives in. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}
