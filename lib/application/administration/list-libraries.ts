/**
 * Use cases: user libraries and their review queue, and ownership claims.
 *
 * Both read `library`; what separates them is the join to `library_claim`.
 * Ingestion is not built yet (architecture.md 21), so these lists are
 * legitimately empty rather than seeded with something that looks like content.
 */
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { ref } from './column-ref';
import { likePattern } from './like-pattern';

/** `sample`: auto-published libraries drawn for a person's look (lib/application/review/rules.ts), not yet closed. */
export type LibraryReviewFilter = 'all' | 'pending' | 'approved' | 'rejected' | 'sample';

const OPEN_SAMPLE = sql`exists (
  select 1 from ${schema.libraryReview}
  where ${ref(schema.libraryReview.libraryId)} = ${ref(schema.library.id)}
    and ${ref(schema.libraryReview.stage)} = 'sample'
    and ${ref(schema.libraryReview.decidedAt)} is null
)`;

export interface ConsoleLibraryRow {
  id: string;
  publicId: string;
  title: string;
  ownerName: string | null;
  sourceType: string | null;
  storageBytes: number;
  visibility: 'public' | 'private';
  lifecycleStatus: string;
  createdAt: Date;
  /** Whether the current version is indexed, which approval requires. */
  hasReadyVersion: boolean;
}

/** Whether `current_version_id` points at a version whose index is ready. */
const hasReadyVersion = sql<boolean>`exists (
  select 1 from ${schema.libraryVersion}
  where ${ref(schema.libraryVersion.id)} = ${ref(schema.library.currentVersionId)}
    and ${ref(schema.libraryVersion.indexStatus)} = 'ready'
)`;

/** The one source a library was built from, when it has exactly one. */
const sourceType = sql<string | null>`(
  select ${ref(schema.source.type)} from ${schema.source}
  where ${ref(schema.source.libraryId)} = ${ref(schema.library.id)}
  order by ${ref(schema.source.id)} limit 1
)`;

const ownerName = sql<string | null>`(
  select ${ref(schema.workspace.name)} from ${schema.workspace}
  where ${ref(schema.workspace.id)} = ${ref(schema.library.ownerWorkspaceId)}
)`;

/**
 * The design's review tabs against the lifecycle enum. There is no single
 * `rejected` state: requirement.md 5.3 gives a reviewer approve, reject and
 * request-changes, and the schema spells the last two as `changes_requested`
 * and `suspended`, with `archived` for a library taken out of circulation.
 */
export const REVIEW_STATUSES = {
  pending: ['submitted', 'reviewing'],
  approved: ['published'],
  rejected: ['changes_requested', 'suspended', 'archived'],
} as const;

/**
 * When a library entered the reviewer's queue.
 *
 * `library` keeps no timestamp of the move to `submitted`, and `library_review`
 * is written on a decision, not a submission. What the tables do hold is
 * enough: a public library is submitted by the build that lands a version
 * (`lifecycleAfterBuild`), so the submission is the first version built after
 * the last decision -- or the first version ever, when nobody has decided
 * yet. Measured that way, an owner rebuilding their submission every day does
 * not reset the reviewer's clock, and a resubmission after `changes_requested`
 * counts from the resubmission rather than from the library's birth.
 */
export const waitingSince = sql<Date>`coalesce((
  select min(${ref(schema.libraryVersion.createdAt)}) from ${schema.libraryVersion}
  where ${ref(schema.libraryVersion.libraryId)} = ${ref(schema.library.id)}
    and ${ref(schema.libraryVersion.createdAt)} > coalesce((
      select max(${ref(schema.libraryReview.decidedAt)}) from ${schema.libraryReview}
      where ${ref(schema.libraryReview.libraryId)} = ${ref(schema.library.id)}
    ), '-infinity'::timestamptz)
), ${ref(schema.library.createdAt)})`;

/** User libraries that still exist; a deleted one is a tombstone (8.4). */
const LIVE_USER_LIBRARY = and(
  eq(schema.library.isPlatformLibrary, false),
  isNull(schema.library.deletedAt),
)!;

const LIBRARY_ROW = {
  id: schema.library.id,
  publicId: schema.library.publicId,
  title: schema.library.title,
  storageBytes: schema.library.storageBytes,
  visibility: schema.library.visibility,
  lifecycleStatus: schema.library.lifecycleStatus,
  createdAt: schema.library.createdAt,
  ownerName,
  sourceType,
  hasReadyVersion,
};

/**
 * The libraries a reviewer should look at next: those waiting, longest wait
 * first. One statement, for the overview panel that shows the head of the
 * queue beside a tile that reports how long its oldest member has waited --
 * the two have to agree on which library that is.
 */
export async function pendingReviewQueue(input: { limit?: number } = {}): Promise<ConsoleLibraryRow[]> {
  const rows = await db()
    .select(LIBRARY_ROW)
    .from(schema.library)
    .where(and(LIVE_USER_LIBRARY, inArray(schema.library.lifecycleStatus, [...REVIEW_STATUSES.pending])))
    .orderBy(asc(waitingSince), asc(schema.library.id))
    .limit(input.limit ?? 5);
  return rows.map(normalize);
}

function reviewCondition(filter: LibraryReviewFilter) {
  /*
   * The filter arrives as a cast, not a parse -- the export route hands
   * whatever `?status=` said straight through -- so an unknown value must fall
   * back to `all` rather than spreading `undefined` into a 500.
   */
  switch (filter) {
    case 'pending':
    case 'approved':
    case 'rejected':
      return inArray(schema.library.lifecycleStatus, [...REVIEW_STATUSES[filter]]);
    case 'sample':
      return OPEN_SAMPLE;
    default:
      return undefined;
  }
}

export async function listUserLibraries(input: {
  query?: string;
  review?: LibraryReviewFilter;
  limit?: number;
} = {}): Promise<{ rows: ConsoleLibraryRow[]; total: number; counts: Record<string, number> }> {
  const database = db();
  const term = input.query?.trim();

  const base = LIVE_USER_LIBRARY;
  const conditions = [
    base,
    term
      ? or(ilike(schema.library.title, likePattern(term)), ilike(schema.library.publicId, likePattern(term)))
      : undefined,
    reviewCondition(input.review ?? 'all'),
  ].filter(Boolean);

  const [rows, [totalRow], statusRows, [claimRow], [sampleRow]] = await Promise.all([
    database
      .select(LIBRARY_ROW)
      .from(schema.library)
      .where(and(...conditions))
      .orderBy(desc(schema.library.createdAt))
      .limit(input.limit ?? 50),
    database.select({ n: count() }).from(schema.library).where(and(...conditions)),
    database
      .select({ status: schema.library.lifecycleStatus, n: count() })
      .from(schema.library)
      .where(base)
      .groupBy(schema.library.lifecycleStatus),
    database
      .select({ n: count() })
      .from(schema.libraryClaim)
      .where(eq(schema.libraryClaim.status, 'pending')),
    database.select({ n: count() }).from(schema.library).where(and(base, OPEN_SAMPLE)),
  ]);

  const byStatus = new Map<string, number>(statusRows.map((row) => [row.status, row.n]));
  const sum = (statuses: readonly string[]) =>
    statuses.reduce((total, status) => total + (byStatus.get(status) ?? 0), 0);

  return {
    rows: rows.map(normalize),
    total: totalRow?.n ?? 0,
    counts: {
      all: [...byStatus.values()].reduce((a, b) => a + b, 0),
      pending: sum(REVIEW_STATUSES.pending),
      approved: sum(REVIEW_STATUSES.approved),
      rejected: sum(REVIEW_STATUSES.rejected),
      sample: sampleRow?.n ?? 0,
      claims: claimRow?.n ?? 0,
    },
  };
}

export type ClaimFilter = 'all' | 'pending' | 'claimed' | 'revoked' | 'disputed' | 'expired';

/**
 * `claim_status` has no `disputed` value, and should not: requirement.md 7.3
 * defines a dispute as a claim opened on a library that already has *another*
 * owner, which is a fact about the pair rather than a state of the claim. It
 * is derived here so the tab means what the rule says.
 *
 * The `<>` clause is the whole of it. Without it the queue counts a claim by
 * the workspace that already owns the library -- and offers a Grant control
 * that `ruleDispute` then refuses as "not a dispute", which is the console
 * disagreeing with itself. `isDisputedClaim` is the same predicate in
 * TypeScript, for every caller that has the rows rather than the query.
 */
const DISPUTED = sql`${schema.libraryClaim.status} = 'pending'
  and ${schema.library.ownerWorkspaceId} is not null
  and ${schema.library.ownerWorkspaceId} <> ${schema.libraryClaim.claimantWorkspaceId}`;

/** The same derivation as `DISPUTED`, per row, so the list can mark one. */
const IS_DISPUTED = sql<boolean>`(${DISPUTED})`;

export interface ConsoleClaimRow {
  id: string;
  libraryTitle: string;
  libraryPublicId: string;
  claimantName: string;
  method: string;
  openedAt: Date;
  currentOwner: string | null;
  status: string;
  /** Pending on a library that already has an owner: an administrator decides it. */
  disputed: boolean;
}

export async function listClaims(
  input: { query?: string; status?: ClaimFilter; limit?: number; offset?: number } = {},
): Promise<{
  rows: ConsoleClaimRow[];
  total: number;
  counts: Record<string, number>;
}> {
  const database = db();
  const term = input.query?.trim();

  const statusCondition = claimCondition(input.status ?? 'all');
  const conditions = [
    /* A claim on a deleted library is moot; the queue does not show it. */
    isNull(schema.library.deletedAt),
    statusCondition,
    term
      ? or(ilike(schema.library.title, likePattern(term)), ilike(schema.library.publicId, likePattern(term)))
      : undefined,
  ].filter(Boolean);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const claimant = sql<string>`(
    select ${ref(schema.workspace.name)} from ${schema.workspace}
    where ${ref(schema.workspace.id)} = ${ref(schema.libraryClaim.claimantWorkspaceId)}
  )`;

  const [rows, [totalRow], statusRows, [disputedRow]] = await Promise.all([
    database
      .select({
        id: schema.libraryClaim.id,
        libraryTitle: schema.library.title,
        libraryPublicId: schema.library.publicId,
        method: schema.libraryClaim.method,
        status: schema.libraryClaim.status,
        openedAt: schema.libraryClaim.createdAt,
        currentOwner: ownerName,
        claimantName: claimant,
        disputed: IS_DISPUTED,
      })
      .from(schema.libraryClaim)
      .innerJoin(schema.library, eq(schema.library.id, schema.libraryClaim.libraryId))
      .where(where)
      .orderBy(desc(schema.libraryClaim.createdAt))
      .limit(input.limit ?? 50)
      .offset(input.offset ?? 0),
    database
      .select({ n: count() })
      .from(schema.libraryClaim)
      .innerJoin(schema.library, eq(schema.library.id, schema.libraryClaim.libraryId))
      .where(where),
    database
      .select({ status: schema.libraryClaim.status, n: count() })
      .from(schema.libraryClaim)
      .groupBy(schema.libraryClaim.status),
    database
      .select({ n: count() })
      .from(schema.libraryClaim)
      .innerJoin(schema.library, eq(schema.library.id, schema.libraryClaim.libraryId))
      .where(DISPUTED),
  ]);

  const byStatus = new Map<string, number>(statusRows.map((row) => [row.status, row.n]));
  return {
    rows: rows.map((row) => ({
      ...row,
      claimantName: row.claimantName ?? '',
      currentOwner: row.currentOwner,
      disputed: Boolean(row.disputed),
    })),
    total: totalRow?.n ?? 0,
    counts: {
      all: [...byStatus.values()].reduce((a, b) => a + b, 0),
      pending: byStatus.get('pending') ?? 0,
      claimed: byStatus.get('verified') ?? 0,
      revoked: byStatus.get('revoked') ?? 0,
      expired: byStatus.get('expired') ?? 0,
      disputed: disputedRow?.n ?? 0,
    },
  };
}

function claimCondition(filter: ClaimFilter) {
  switch (filter) {
    case 'pending':
      return eq(schema.libraryClaim.status, 'pending');
    case 'claimed':
      return eq(schema.libraryClaim.status, 'verified');
    case 'revoked':
      return eq(schema.libraryClaim.status, 'revoked');
    case 'expired':
      return eq(schema.libraryClaim.status, 'expired');
    case 'disputed':
      return DISPUTED;
    default:
      return undefined;
  }
}

function normalize(row: {
  id: string;
  publicId: string;
  title: string;
  storageBytes: number;
  visibility: 'public' | 'private';
  lifecycleStatus: string;
  createdAt: Date;
  ownerName: string | null;
  sourceType: string | null;
  hasReadyVersion: boolean;
}): ConsoleLibraryRow {
  return {
    hasReadyVersion: row.hasReadyVersion,
    id: row.id,
    publicId: row.publicId,
    title: row.title,
    ownerName: row.ownerName,
    sourceType: row.sourceType,
    storageBytes: row.storageBytes,
    visibility: row.visibility,
    lifecycleStatus: row.lifecycleStatus,
    createdAt: row.createdAt,
  };
}
