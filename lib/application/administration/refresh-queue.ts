/**
 * The refresh queue as one screen: what is running, what is waiting, what has
 * just finished, and what the policies will queue next.
 *
 * `manage-platform-libraries.ts` shows a library's own operations on its
 * detail page; this is the view across libraries, for the operator who wants
 * to know whether the drain is keeping up rather than whether one library
 * built. Platform libraries only, like the rest of the console's platform
 * screens: a workspace's builds are its own business and show in its
 * dashboard.
 */
import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { BuildProgress, FetchSummary, IngestionStage, OperationTrigger } from '@/lib/domain/ingestion';
import { isOperationTrigger } from '@/lib/domain/ingestion';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export interface RefreshQueueRow {
  id: string;
  libraryId: string;
  publicId: string;
  title: string;
  operationType: string;
  /** The one source the operation fetches; null means every source. */
  sourceId: string | null;
  sourceType: string | null;
  location: string | null;
  trigger: OperationTrigger;
  status: string;
  attempts: number;
  error: string | null;
  fetchSummary: FetchSummary | null;
  /** Where the build is, or was when it ended; null before the first report. */
  stage: IngestionStage | null;
  progress: BuildProgress | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RefreshQueueCounts {
  pending: number;
  running: number;
  /** Finished in the last 24 hours, by how. */
  succeeded: number;
  skipped: number;
  failed: number;
}

export interface RefreshQueue {
  /** Running first, then waiting in the order the drain will take them. */
  open: RefreshQueueRow[];
  /** Finished operations, newest first. */
  recent: RefreshQueueRow[];
  counts: RefreshQueueCounts;
}

const OPEN_STATES = ['pending', 'running'] as const;
const CLOSED_STATES = ['succeeded', 'failed', 'skipped', 'cancelled'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function listRefreshQueue(
  input: { recentLimit?: number; now?: Date } = {},
): Promise<RefreshQueue> {
  const database = db();
  const now = input.now ?? new Date();
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const recentLimit = Math.max(1, Math.min(200, input.recentLimit ?? 50));

  const isPlatform = and(
    eq(schema.library.isPlatformLibrary, true),
    isNull(schema.library.deletedAt),
  );

  const columns = {
    id: schema.workflowOperation.id,
    libraryId: schema.library.id,
    publicId: schema.library.publicId,
    title: schema.library.title,
    operationType: schema.workflowOperation.operationType,
    sourceId: schema.workflowOperation.sourceId,
    sourceType: schema.source.type,
    location: schema.source.location,
    trigger: schema.workflowOperation.trigger,
    status: schema.workflowOperation.status,
    attempts: schema.workflowOperation.attempts,
    error: schema.workflowOperation.error,
    fetchSummary: schema.workflowOperation.fetchSummary,
    stage: sql<IngestionStage | null>`${schema.workflowOperation.stage}`,
    progress: schema.workflowOperation.progress,
    createdAt: schema.workflowOperation.createdAt,
    updatedAt: schema.workflowOperation.updatedAt,
  };

  const base = () =>
    database
      .select(columns)
      .from(schema.workflowOperation)
      .innerJoin(schema.library, eq(schema.library.id, schema.workflowOperation.libraryId))
      .leftJoin(schema.source, eq(schema.source.id, schema.workflowOperation.sourceId));

  const [open, recent, [counted]] = await Promise.all([
    base()
      .where(and(isPlatform, inArray(schema.workflowOperation.status, [...OPEN_STATES])))
      /* `running` sorts before `pending` by the letters alone; the rest is queue order. */
      .orderBy(desc(schema.workflowOperation.status), asc(schema.workflowOperation.createdAt)),
    base()
      .where(and(isPlatform, inArray(schema.workflowOperation.status, [...CLOSED_STATES])))
      .orderBy(desc(schema.workflowOperation.updatedAt))
      .limit(recentLimit),
    database
      .select({
        pending: sql<number>`(count(*) filter (where ${schema.workflowOperation.status} = 'pending'))::int`,
        running: sql<number>`(count(*) filter (where ${schema.workflowOperation.status} = 'running'))::int`,
        succeeded: sql<number>`(count(*) filter (
          where ${schema.workflowOperation.status} = 'succeeded'
            and ${schema.workflowOperation.updatedAt} >= ${dayAgo}
        ))::int`,
        skipped: sql<number>`(count(*) filter (
          where ${schema.workflowOperation.status} = 'skipped'
            and ${schema.workflowOperation.updatedAt} >= ${dayAgo}
        ))::int`,
        failed: sql<number>`(count(*) filter (
          where ${schema.workflowOperation.status} = 'failed'
            and ${schema.workflowOperation.updatedAt} >= ${dayAgo}
        ))::int`,
      })
      .from(schema.workflowOperation)
      .innerJoin(schema.library, eq(schema.library.id, schema.workflowOperation.libraryId))
      .where(
        and(
          isPlatform,
          gte(schema.workflowOperation.updatedAt, dayAgo),
        ),
      ),
  ]);

  const row = (record: (typeof open)[number]): RefreshQueueRow => ({
    ...record,
    trigger: isOperationTrigger(record.trigger) ? record.trigger : 'manual',
  });

  return {
    open: open.map(row),
    recent: recent.map(row),
    counts: {
      pending: counted?.pending ?? 0,
      running: counted?.running ?? 0,
      succeeded: counted?.succeeded ?? 0,
      skipped: counted?.skipped ?? 0,
      failed: counted?.failed ?? 0,
    },
  };
}
