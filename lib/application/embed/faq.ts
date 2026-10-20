/**
 * The owner's FAQ: recurring widget questions grouped, answered once, and
 * handed to the next build. requirement.md 9.4, lib/domain/faq.ts.
 *
 * Grouping embeds the recent visitors' questions with the retrieval
 * embedding adapter when one is configured -- the same model the chunks
 * are embedded with -- and falls back to exact text otherwise. Saving or
 * removing an entry queues a rebuild the way the files page does
 * (lib/application/libraries/files.ts): a pending build will read the
 * entries anyway, a running one needs a new row behind it.
 */
import { and, asc, count, desc, eq, gte } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
/* From the module, not the libraries index: the index reaches into ingestion, which builds FAQ entries. */
import { canManageLibraries, type WorkspaceRole } from '@/lib/application/libraries/delete';
import { queueBuildUnlessPending } from '@/lib/application/libraries/queue-build';
import { assertBuildAffordable } from '@/lib/application/plans/build-quota';
import { defaultRetrievalDependencies } from '@/lib/application/retrieval/query-docs';
import {
  FAQ_LIMITS,
  groupQuestions,
  normaliseQuestion,
  validateFaqEntry,
  type FaqEntryContent,
  type FaqRefusal,
  type QuestionGroup,
  type QuestionItem,
} from '@/lib/domain/faq';
import { uuidv7 } from '@/lib/domain/id';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { requireOwnedLibrary } from './site-keys';

/** Thrown for a bad field; the server action turns it into a form message. */
export class FaqInvalid extends AppError {
  constructor(readonly field: FaqRefusal) {
    super('invalid_request', `faq: ${field}`);
  }
}

export interface FaqGroupView extends QuestionGroup {
  /** An entry already covers this question (same text once normalised). */
  covered: boolean;
}

/** How many recent questions grouping reads, and how far back. */
export const FAQ_GROUPING = { days: 30, maxQuestions: 300 } as const;

/** How long a library's grouping is kept once made, and how many libraries' at once. */
export const FAQ_GROUP_CACHE = { ttlMs: 10 * 60 * 1000, maxLibraries: 200 } as const;

const groupCache = new Map<string, { key: string; at: number; groups: FaqGroupView[] }>();

/**
 * Recent visitors' questions, grouped by intent, most asked first. Reads
 * only what the workspace owns; previews are the owner's own and are left
 * out. Embedding is best-effort: a provider that fails leaves the groups
 * to exact text rather than failing the page.
 */
export async function listFaqGroups(input: {
  workspaceId: string;
  libraryId: string;
  dependencies?: Pick<ReturnType<typeof defaultRetrievalDependencies>, 'embeddings' | 'configured'>;
}): Promise<FaqGroupView[]> {
  await requireOwnedLibrary(input.workspaceId, input.libraryId);
  const since = new Date(Date.now() - FAQ_GROUPING.days * 86_400_000);
  const [rows, entries] = await Promise.all([
    db()
      .select({
        id: schema.widgetExchange.id,
        question: schema.widgetExchange.question,
        outcome: schema.widgetExchange.outcome,
        answer: schema.widgetExchange.answer,
        sources: schema.widgetExchange.sources,
      })
      .from(schema.widgetExchange)
      .where(
        and(
          eq(schema.widgetExchange.libraryId, input.libraryId),
          eq(schema.widgetExchange.preview, false),
          gte(schema.widgetExchange.createdAt, since),
        ),
      )
      .orderBy(desc(schema.widgetExchange.createdAt))
      .limit(FAQ_GROUPING.maxQuestions),
    db()
      .select({ question: schema.libraryFaq.question })
      .from(schema.libraryFaq)
      .where(eq(schema.libraryFaq.libraryId, input.libraryId)),
  ]);
  if (rows.length === 0) return [];

  /*
   * The grouping is read on every render of the library's page, which polls
   * while a build runs; the embedding call behind it must not be. The result
   * is kept per library for as long as nothing it was made from has changed
   * -- the newest exchange, how many there are, the entries -- and for at
   * most `FAQ_GROUP_CACHE.ttlMs` either way. Per process: a serverless
   * instance that is reused keeps it, a fresh one pays once.
   */
  const cacheKey = `${rows[0]!.id}:${rows.length}:${entries.map((entry) => entry.question).join('\u0000')}`;
  const cached = groupCache.get(input.libraryId);
  if (cached && cached.key === cacheKey && Date.now() - cached.at < FAQ_GROUP_CACHE.ttlMs) {
    return cached.groups;
  }

  const dependencies = input.dependencies ?? defaultRetrievalDependencies();
  let vectors: number[][] | null = null;
  try {
    if ((await dependencies.configured()).embeddings) {
      vectors = await (await dependencies.embeddings()).embed(rows.map((row) => row.question));
    }
  } catch (error) {
    console.warn(`faq grouping without embeddings: ${error instanceof Error ? error.message : 'unknown'}`);
    vectors = null;
  }

  /* Read newest-first to take the latest N; grouped oldest-first, so a
     group is named by the first way the question was asked. */
  const ordered = rows.map((row, at) => ({ row, vector: vectors?.[at] })).reverse();
  const items: QuestionItem[] = ordered.map(({ row, vector }) => ({
    id: row.id,
    question: row.question,
    vector,
    answered: row.outcome === 'answer' || row.outcome === 'degraded',
    answer: row.outcome === 'answer' ? row.answer : null,
    pages: row.sources,
  }));
  const covered = new Set(entries.map((entry) => normaliseQuestion(entry.question)));
  const groups = groupQuestions(items).map((group) => ({
    ...group,
    covered: group.questions.some((question) => covered.has(normaliseQuestion(question))),
  }));
  if (groupCache.size >= FAQ_GROUP_CACHE.maxLibraries) {
    const oldest = groupCache.keys().next().value;
    if (oldest !== undefined) groupCache.delete(oldest);
  }
  groupCache.delete(input.libraryId);
  groupCache.set(input.libraryId, { key: cacheKey, at: Date.now(), groups });
  return groups;
}

/** Test seam: the grouping cache is module state. */
export function resetFaqGroupCache(): void {
  groupCache.clear();
}

export interface FaqEntryView extends FaqEntryContent {
  createdAt: string;
  updatedAt: string;
}

export async function listFaqEntries(input: { workspaceId: string; libraryId: string }): Promise<FaqEntryView[]> {
  const rows = await db()
    .select()
    .from(schema.libraryFaq)
    .where(
      and(eq(schema.libraryFaq.workspaceId, input.workspaceId), eq(schema.libraryFaq.libraryId, input.libraryId)),
    )
    .orderBy(asc(schema.libraryFaq.createdAt));
  return rows.map((row) => ({
    id: row.id,
    question: row.question,
    answer: row.answer,
    pageUrl: row.pageUrl,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export interface SaveFaqEntryInput {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
  /** Absent to create; present to edit. */
  entryId?: string | null;
  question: string;
  answer: string;
  pageUrl: string;
}

export interface FaqChangeResult {
  entry: FaqEntryView | null;
  /** The build queued or found waiting; the entries reach retrieval when it publishes. */
  operationId: string;
}

export async function saveFaqEntry(input: SaveFaqEntryInput): Promise<FaqChangeResult> {
  if (!canManageLibraries(input.role)) {
    throw new AppError('access_denied', 'only a library manager can edit the FAQ');
  }
  await requireOwnedLibrary(input.workspaceId, input.libraryId);
  const refusal = validateFaqEntry(input);
  if (refusal) throw new FaqInvalid(refusal);
  const question = input.question.trim();
  const answer = input.answer.trim();
  const pageUrl = input.pageUrl.trim();

  /* A FAQ change queues a build; refused up front when the balance cannot
     cover the base fee, as the files page refuses. Entries fetch no pages. */
  await assertBuildAffordable({ workspaceId: input.workspaceId, fetchesPages: false });

  const database = db();
  const now = new Date();
  let row: typeof schema.libraryFaq.$inferSelect | undefined;
  if (input.entryId) {
    [row] = await database
      .update(schema.libraryFaq)
      .set({ question, answer, pageUrl, updatedAt: now })
      .where(
        and(
          eq(schema.libraryFaq.id, input.entryId),
          eq(schema.libraryFaq.workspaceId, input.workspaceId),
          eq(schema.libraryFaq.libraryId, input.libraryId),
        ),
      )
      .returning();
    if (!row) throw new AppError('library_not_found', 'no such FAQ entry');
  } else {
    const [existing] = await database
      .select({ n: count() })
      .from(schema.libraryFaq)
      .where(eq(schema.libraryFaq.libraryId, input.libraryId));
    if ((existing?.n ?? 0) >= FAQ_LIMITS.maxEntries) throw new FaqInvalid('limit');
    [row] = await database
      .insert(schema.libraryFaq)
      .values({
        id: uuidv7(),
        libraryId: input.libraryId,
        workspaceId: input.workspaceId,
        question,
        answer,
        pageUrl,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
  }
  const operationId = await queueBuildUnlessPending(database, input.libraryId);
  return {
    entry: row
      ? {
          id: row.id,
          question: row.question,
          answer: row.answer,
          pageUrl: row.pageUrl,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        }
      : null,
    operationId,
  };
}

export async function deleteFaqEntry(input: {
  workspaceId: string;
  role: WorkspaceRole;
  libraryId: string;
  entryId: string;
}): Promise<FaqChangeResult> {
  if (!canManageLibraries(input.role)) {
    throw new AppError('access_denied', 'only a library manager can edit the FAQ');
  }
  await requireOwnedLibrary(input.workspaceId, input.libraryId);
  const removed = await db()
    .delete(schema.libraryFaq)
    .where(
      and(
        eq(schema.libraryFaq.id, input.entryId),
        eq(schema.libraryFaq.workspaceId, input.workspaceId),
        eq(schema.libraryFaq.libraryId, input.libraryId),
      ),
    )
    .returning({ id: schema.libraryFaq.id });
  if (removed.length === 0) throw new AppError('library_not_found', 'no such FAQ entry');
  return { entry: null, operationId: await queueBuildUnlessPending(db(), input.libraryId) };
}
