/**
 * The agent workspace's index (docs/design/agent-workspace.md §2.2, §5, §6):
 * which files are indexed, when, at what cost, and searching them.
 *
 * A file is indexed when its own `index_mode`, or the nearest folder's above
 * it that is not `inherit`, is `on`, or when a Ree binds it (a binding on it
 * or a folder above it that does not exclude it). Every change of content
 * sets `index_due_at` two minutes ahead (workspace.ts `putText`), so a burst
 * of saves is indexed once; the cron (`/api/cron/workspace-index`, every
 * minute) takes due files and:
 *   1. cuts the text into passages by lines at content-defined points
 *      (`chunkFile`), each with the hash of its text alone (`content_digest`),
 *      so an edit changes only the passages around it;
 *   2. reuses the vector of every passage the workspace already holds in the
 *      current embedding space, and embeds only the rest -- a metered run
 *      (`workspace_index`) billed to the owner like knowledge processing,
 *      within the console's `workspaceIndexBudget` a day;
 *   3. replaces the file's passages and records the version they index;
 *   4. brings every Ree bound to it up to date (workspace-rees.ts).
 * Nothing in a write request embeds or spends: a file over budget simply
 * waits for the next day, and `ws_grep` reads it meanwhile.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  WORKSPACE_INDEX_BATCH,
  WORKSPACE_INDEX_CLAIM_MS,
  WORKSPACE_SEARCH_MAX,
} from '@/lib/constants';
import { InsufficientCredits } from '@/lib/domain/credits';
import { estimateTokens } from '@/lib/domain/knowledge';
import { providerTotal } from '@/lib/domain/provider-cost';
import { fuse, keywordCoverage, searchTerms } from '@/lib/domain/retrieval';
import { chunkFile, effectiveIndexMode, excludedBy, nameOf } from '@/lib/domain/workspace';
import { embedTexts, endpointFor, type ModelEndpoint } from '@/lib/infra/ai/models';
import { modelCostTarget, quoteProviderCost } from '@/lib/infra/ai/provider-meter';
import { db, schema, type Executor } from '@/lib/infra/db';
import { spaceOf } from '@/lib/services/embedding-space';
import { closeMeteredRun, meterInto, openMeteredRun } from '@/lib/services/metered-work';
import { providerPrices } from '@/lib/services/provider-pricing';
import { effectiveCeiling } from '@/lib/services/rate-limit-settings';
import { storingSpace } from '@/lib/services/reembed';
import { embedQuestion } from '@/lib/services/retrieval';
import { existing, requireWriteAccess, resolvePath, shown, within, WorkspaceError, type WorkspaceScope } from '@/lib/services/workspace';

type Entry = typeof schema.workspaceEntry.$inferSelect;

export const digestOf = (text: string): string => createHash('sha256').update(text).digest('hex');

export interface DraftPassage {
  ordinal: number;
  content: string;
  locator: { path?: string; line?: number; heading?: string };
  digest: string;
}

/** A file's passages: content-defined cuts by lines (`chunkFile`), under its name (never its path, which may say more than a citation should). */
export function passagesOf(path: string, text: string): DraftPassage[] {
  return chunkFile(nameOf(path), text, { estimate: estimateTokens }).map((chunk) => ({ ordinal: chunk.ordinal, content: chunk.content, locator: chunk.locator, digest: digestOf(chunk.content) }));
}

/* ------------------------------------------------------------------ who needs an index */

interface Placed {
  id: string;
  path: string;
  /** As Postgres lowers it, like every other path compared here. */
  lower: string;
}

/** The workspace's explicit index modes and live bindings, for deciding about any number of its files. */
async function indexRules(executor: Executor, workspaceId: string) {
  const modes = await executor.execute<{ lower: string; mode: string }>(sql`
    select lower(path) as lower, index_mode as mode from ${schema.workspaceEntry}
    where workspace_id = ${workspaceId} and deleted_at is null and index_mode <> 'inherit'`);
  const bindings = await executor.execute<{ id: string; ree_id: string; path: string; lower: string; exclude: string[] }>(sql`
    select b.id, b.ree_id, e.path, lower(e.path) as lower, b.exclude from ${schema.reeBinding} b
    join ${schema.workspaceEntry} e on e.id = b.entry_id and e.deleted_at is null
    where b.workspace_id = ${workspaceId}`);
  return { modes: new Map(modes.rows.map((row) => [row.lower, row.mode])), bindings: bindings.rows };
}

type Rules = Awaited<ReturnType<typeof indexRules>>;

/** The bindings that bring a file into a Ree: on it, or on a folder above it that does not exclude it. */
export function bindingsOf(rules: Rules, file: Placed) {
  return rules.bindings.filter((binding) => {
    if (binding.lower === file.lower) return true;
    if (!file.lower.startsWith(`${binding.lower}/`)) return false;
    /* Both paths were matched case-insensitively by Postgres; the relative part is cut by characters. */
    const relative = Array.from(file.path).slice(Array.from(binding.path).length + 1).join('');
    return !excludedBy(binding.exclude, relative);
  });
}

function wanted(rules: Rules, file: Placed): boolean {
  return effectiveIndexMode(file.lower, rules.modes) === 'on' || bindingsOf(rules, file).length > 0;
}

/* ------------------------------------------------------------------ cost */

/** What embedding these texts would cost, in credits (rounded up), or null when no price is known. */
async function quote(texts: readonly string[], endpoint: ModelEndpoint): Promise<{ tokens: number; credits: number | null }> {
  const tokens = texts.reduce((sum, text) => sum + estimateTokens(text), 0);
  if (tokens === 0) return { tokens, credits: 0 };
  const usd = await quoteProviderCost(modelCostTarget(endpoint, 'embedding'), await providerPrices(), { inputTokens: tokens });
  return { tokens, credits: usd === null ? null : providerTotal([{ costUsd: usd }]).credits };
}

/** The passages of `files` that indexing would embed: those whose digest the workspace does not hold in the current space. */
async function unindexed(workspaceId: string, files: readonly { path: string; text: string }[], space: string): Promise<string[]> {
  const passages = files.flatMap((file) => passagesOf(file.path, file.text));
  if (passages.length === 0) return [];
  const digests = [...new Set(passages.map((passage) => passage.digest))];
  const held = new Set<string>();
  for (let at = 0; at < digests.length; at += 5_000) {
    const slice = digests.slice(at, at + 5_000);
    const rows = await db()
      .selectDistinct({ digest: schema.workspacePassage.contentDigest })
      .from(schema.workspacePassage)
      .where(and(eq(schema.workspacePassage.workspaceId, workspaceId), eq(schema.workspacePassage.embeddingSpace, space), inArray(schema.workspacePassage.contentDigest, slice)));
    for (const row of rows) held.add(row.digest);
  }
  const seen = new Set<string>();
  return passages.filter((passage) => !held.has(passage.digest) && !seen.has(passage.digest) && seen.add(passage.digest)).map((passage) => passage.content);
}

export interface IndexEstimate {
  files: number;
  /** Files whose passages are all held already: indexing them is free. */
  reused: number;
  tokens: number;
  credits: number | null;
}

/** What indexing the text files at or below `path` would cost now (an upper bound: the passages to embed, at today's price). */
export async function estimateIndex(scope: WorkspaceScope, rawPath: unknown): Promise<IndexEstimate> {
  const folder = resolvePath(scope, rawPath ?? '/');
  const files = await db()
    .select({ path: schema.workspaceEntry.path, text: schema.workspaceEntry.text })
    .from(schema.workspaceEntry)
    .where(and(eq(schema.workspaceEntry.workspaceId, scope.workspaceId), isNull(schema.workspaceEntry.deletedAt), eq(schema.workspaceEntry.kind, 'file'), isNotNull(schema.workspaceEntry.text), within(folder)));
  const endpoint = await endpointFor('embedding');
  const space = spaceOf(endpoint);
  let reused = 0;
  const texts: string[] = [];
  for (const file of files) {
    const missing = await unindexed(scope.workspaceId, [{ path: file.path, text: file.text ?? '' }], space);
    if (missing.length === 0) reused += 1;
    texts.push(...missing);
  }
  const { tokens, credits } = await quote(texts, endpoint);
  return { files: files.length, reused, tokens, credits };
}

/** Index modes of the folders that have one, and of the folders Ree bindings cover, for the usage page. */
export async function indexedFolders(scope: WorkspaceScope) {
  const rows = await db().execute<{ path: string; kind: string; mode: string; bound: boolean }>(sql`
    select e.path, e.kind, e.index_mode as mode,
      exists (select 1 from ${schema.reeBinding} b where b.entry_id = e.id) as bound
    from ${schema.workspaceEntry} e
    where e.workspace_id = ${scope.workspaceId} and e.deleted_at is null and ${within(scope.root, sql`e.path`)}
      and (e.index_mode <> 'inherit' or exists (select 1 from ${schema.reeBinding} b where b.entry_id = e.id))
    order by lower(e.path)
    limit 500`);
  return rows.rows.map((row) => ({ path: shown(scope, row.path), kind: row.kind as 'file' | 'folder', mode: row.mode as 'inherit' | 'on' | 'off', bound: row.bound }));
}

/** Files waiting for the index, being indexed, or stopped (budget, credits), newest change first. */
export async function indexQueue(scope: WorkspaceScope, limit = 50) {
  const rows = await db()
    .select({ path: schema.workspaceEntry.path, due: schema.workspaceEntry.indexDueAt, claimed: schema.workspaceEntry.indexClaimedAt, error: schema.workspaceEntry.indexError, indexed: schema.workspaceEntry.indexedRevisionId, current: schema.workspaceEntry.currentRevisionId })
    .from(schema.workspaceEntry)
    .where(and(eq(schema.workspaceEntry.workspaceId, scope.workspaceId), isNull(schema.workspaceEntry.deletedAt), eq(schema.workspaceEntry.kind, 'file'), or(isNotNull(schema.workspaceEntry.indexDueAt), isNotNull(schema.workspaceEntry.indexError)), within(scope.root)))
    .orderBy(asc(schema.workspaceEntry.indexDueAt))
    .limit(limit);
  return rows.map((row) => ({ path: shown(scope, row.path), dueAt: row.due, indexing: row.claimed !== null, error: row.error, indexedBefore: row.indexed !== null }));
}

/** Today's index spending against the budget. */
export async function indexBudget(userId: string, now = new Date()) {
  const [row] = await db().select({ day: schema.workspaceUsage.indexSpentDay, spent: schema.workspaceUsage.indexSpent }).from(schema.workspaceUsage).where(eq(schema.workspaceUsage.userId, userId));
  const today = now.toISOString().slice(0, 10);
  return { spent: row?.day === today ? row.spent : 0, budget: await effectiveCeiling('workspaceIndexBudget') };
}

/* ------------------------------------------------------------------ turning it on */

/**
 * `ws_index`: a file's or folder's index mode, and every text file at or
 * below it queued to be looked at now. Turning it on quotes the cost first
 * and refuses above `maxCost` (`max_cost_exceeded`) before changing anything.
 */
export async function setIndexMode(scope: WorkspaceScope, input: { path: string; mode: 'on' | 'off' | 'inherit'; maxCost?: number }, now = new Date()) {
  requireWriteAccess(scope);
  const path = resolvePath(scope, input.path);
  const estimate = input.mode === 'on' ? await estimateIndex(scope, input.path) : null;
  if (estimate && input.maxCost !== undefined && (estimate.credits === null || estimate.credits > input.maxCost)) {
    throw new WorkspaceError('max_cost_exceeded', `Indexing ${shown(scope, path)} could cost up to ${estimate.credits ?? 'an unknown number of'} credits, above your max_cost of ${input.maxCost}. Nothing was changed.`, { estimate });
  }
  const entry = await existing(db(), scope, path);
  await db().transaction(async (tx) => {
    await tx.update(schema.workspaceEntry).set({ indexMode: input.mode }).where(eq(schema.workspaceEntry.id, entry.id));
    await tx
      .update(schema.workspaceEntry)
      .set({ indexDueAt: now, indexError: null })
      .where(and(eq(schema.workspaceEntry.workspaceId, scope.workspaceId), isNull(schema.workspaceEntry.deletedAt), eq(schema.workspaceEntry.kind, 'file'), within(entry.path)));
  });
  const [{ queued } = { queued: 0 }] = await db()
    .select({ queued: sql<number>`count(*)::int` })
    .from(schema.workspaceEntry)
    .where(and(eq(schema.workspaceEntry.workspaceId, scope.workspaceId), isNull(schema.workspaceEntry.deletedAt), eq(schema.workspaceEntry.kind, 'file'), within(entry.path)));
  return { path: shown(scope, path), mode: input.mode, queued, estimate, budget: await indexBudget(scope.userId, now) };
}

/** Every text file at or below these entries looked at again now (a binding added, a folder moved under one). */
export async function queueBelow(executor: Executor, workspaceId: string, paths: readonly string[], now = new Date()): Promise<void> {
  for (const path of paths) {
    await executor
      .update(schema.workspaceEntry)
      .set({ indexDueAt: now })
      .where(and(eq(schema.workspaceEntry.workspaceId, workspaceId), isNull(schema.workspaceEntry.deletedAt), eq(schema.workspaceEntry.kind, 'file'), within(path)));
  }
}

/* ------------------------------------------------------------------ the worker */

export type IndexOutcome = 'indexed' | 'current' | 'dropped' | 'budget' | 'insufficient_credits' | 'retry' | 'skipped';

const nextUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

async function release(entryId: string, set: Partial<typeof schema.workspaceEntry.$inferInsert>): Promise<void> {
  await db().update(schema.workspaceEntry).set({ indexClaimedAt: null, ...set }).where(eq(schema.workspaceEntry.id, entryId));
}

/** Takes one due file for this run, or nothing when another run holds it or it is no longer due. */
async function claim(entryId: string, now: Date): Promise<(Entry & { lower: string }) | null> {
  const stale = new Date(now.getTime() - WORKSPACE_INDEX_CLAIM_MS);
  const [row] = await db()
    .update(schema.workspaceEntry)
    .set({ indexClaimedAt: now })
    .where(and(eq(schema.workspaceEntry.id, entryId), isNull(schema.workspaceEntry.deletedAt), lte(schema.workspaceEntry.indexDueAt, now), or(isNull(schema.workspaceEntry.indexClaimedAt), lt(schema.workspaceEntry.indexClaimedAt, stale))))
    .returning();
  if (!row) return null;
  const [lowered] = await db().execute<{ lower: string }>(sql`select lower(${row.path}) as lower`).then((result) => result.rows);
  return { ...row, lower: lowered!.lower };
}

/** The owner of a workspace. */
async function ownerOf(workspaceId: string): Promise<string> {
  const [row] = await db().select({ ownerId: schema.workspace.ownerId }).from(schema.workspace).where(eq(schema.workspace.id, workspaceId));
  return row!.ownerId;
}

/** Indexes one due file (see the header); answers what happened. */
export async function indexEntry(entryId: string, now = new Date()): Promise<IndexOutcome> {
  const entry = await claim(entryId, now);
  if (!entry) return 'skipped';
  try {
    const rules = await indexRules(db(), entry.workspaceId);
    if (entry.kind !== 'file' || entry.text === null || !wanted(rules, entry)) {
      /* No longer indexed (turned off, unbound, a folder): its passages go, and any Ree that had it lets it go. */
      await db().delete(schema.workspacePassage).where(eq(schema.workspacePassage.entryId, entry.id));
      await release(entry.id, { indexDueAt: null, indexError: null, indexedRevisionId: null });
      await syncAfterIndex(entry.workspaceId);
      return 'dropped';
    }
    const endpoint = await endpointFor('embedding');
    const space = spaceOf(endpoint);
    const revisionId = entry.currentRevisionId!;
    const passages = passagesOf(entry.path, entry.text);
    const missing = await unindexed(entry.workspaceId, [{ path: entry.path, text: entry.text }], space);
    if (entry.indexedRevisionId === revisionId && missing.length === 0) {
      await release(entry.id, { indexDueAt: null, indexError: null });
      await syncAfterIndex(entry.workspaceId);
      return 'current';
    }
    const ownerId = await ownerOf(entry.workspaceId);
    let vectors: number[][] = [];
    if (missing.length) {
      const { credits } = await quote(missing, endpoint);
      const budget = await indexBudget(ownerId, now);
      if (credits === null || budget.spent + credits > budget.budget) {
        /* Over today's budget (or no price to know): the file waits for tomorrow, and stays greppable. */
        await release(entry.id, { indexDueAt: nextUtcDay(now), indexError: 'budget' });
        return 'budget';
      }
      const run = await openMeteredRun({ userId: ownerId, reeId: null, kind: 'workspace_index', title: nameOf(entry.path), reeName: '', refuse: true });
      const outcome = await meterInto(run, () => embedTexts(missing, endpoint));
      const charged = await closeMeteredRun(run, outcome.ok ? null : outcome.error instanceof InsufficientCredits ? 'insufficient_credits' : 'failed');
      if (charged) await addSpent(ownerId, charged, now);
      if (!outcome.ok) {
        if (outcome.error instanceof InsufficientCredits) {
          await release(entry.id, { indexDueAt: new Date(now.getTime() + 60 * 60_000), indexError: 'insufficient_credits' });
          return 'insufficient_credits';
        }
        throw outcome.error;
      }
      vectors = outcome.value.vectors;
    }
    const fresh = new Map(missing.map((content, at) => [digestOf(content), vectors[at]!]));
    const stored = await db().transaction(async (tx) => {
      const storing = await storingSpace(tx, endpoint.configId);
      if (storing === null) return false;
      /* New rows above every old ordinal first, so reused vectors are copied while the old rows still hold them. */
      const OFFSET = 1_000_000;
      for (let at = 0; at < passages.length; at += 200) {
        const slice = passages.slice(at, at + 200);
        const newOnes = slice.filter((passage) => fresh.has(passage.digest));
        if (newOnes.length) {
          await tx.insert(schema.workspacePassage).values(
            newOnes.map((passage) => ({
              entryId: entry.id,
              ordinal: passage.ordinal + OFFSET,
              workspaceId: entry.workspaceId,
              revisionId,
              content: passage.content,
              locator: passage.locator,
              contentDigest: passage.digest,
              embedding: fresh.get(passage.digest)!,
              embeddingSpace: storing,
            })),
          );
        }
        const reused = slice.filter((passage) => !fresh.has(passage.digest));
        if (reused.length) {
          await tx.execute(sql`
            insert into ${schema.workspacePassage} (entry_id, ordinal, workspace_id, revision_id, content, locator, content_digest, embedding, embedding_space)
            select ${entry.id}::uuid, d.ordinal + ${OFFSET}, ${entry.workspaceId}::uuid, ${revisionId}::uuid, d.content, d.locator::jsonb, d.digest,
              (select p.embedding from ${schema.workspacePassage} p where p.workspace_id = ${entry.workspaceId}::uuid and p.content_digest = d.digest and p.embedding_space = ${storing}::uuid limit 1),
              ${storing}::uuid
            from jsonb_to_recordset(${JSON.stringify(reused.map((passage) => ({ ordinal: passage.ordinal, content: passage.content, locator: passage.locator, digest: passage.digest })))}::jsonb)
              as d(ordinal int, content text, locator jsonb, digest text)`);
        }
      }
      await tx.delete(schema.workspacePassage).where(and(eq(schema.workspacePassage.entryId, entry.id), lt(schema.workspacePassage.ordinal, OFFSET)));
      await tx.update(schema.workspacePassage).set({ ordinal: sql`${schema.workspacePassage.ordinal} - ${OFFSET}` }).where(eq(schema.workspacePassage.entryId, entry.id));
      /* A save while this ran set a later due time: keep it, so that version is indexed in turn. */
      await tx
        .update(schema.workspaceEntry)
        .set({ indexedRevisionId: revisionId, indexClaimedAt: null, indexError: null, indexDueAt: sql`case when ${schema.workspaceEntry.currentRevisionId} = ${revisionId}::uuid then null else ${schema.workspaceEntry.indexDueAt} end` })
        .where(eq(schema.workspaceEntry.id, entry.id));
      return true;
    });
    if (!stored) {
      /* The embedding model changed meanwhile: try again shortly, in the new space. */
      await release(entry.id, { indexDueAt: new Date(now.getTime() + 5 * 60_000) });
      return 'retry';
    }
    await syncAfterIndex(entry.workspaceId);
    return 'indexed';
  } catch (error) {
    console.warn(`workspace index failed entry=${entry.id}`, error instanceof Error ? error.message : error);
    await release(entry.id, { indexDueAt: new Date(now.getTime() + 15 * 60_000), indexError: 'failed' });
    return 'retry';
  }
}

async function addSpent(userId: string, credits: number, now: Date): Promise<void> {
  const today = now.toISOString().slice(0, 10);
  await db().insert(schema.workspaceUsage).values({ userId }).onConflictDoNothing();
  await db()
    .update(schema.workspaceUsage)
    .set({ indexSpent: sql`case when ${schema.workspaceUsage.indexSpentDay} = ${today}::date then ${schema.workspaceUsage.indexSpent} + ${credits} else ${credits} end`, indexSpentDay: today })
    .where(eq(schema.workspaceUsage.userId, userId));
}

/** The Rees bound in the workspace brought up to date with its index (loaded late: workspace-rees.ts imports this module). */
async function syncAfterIndex(workspaceId: string): Promise<void> {
  const { syncWorkspaceRees } = await import('@/lib/services/workspace-rees');
  await syncWorkspaceRees(workspaceId);
}

/** The cron's run: due files, oldest due first, until `budgetMs` is spent. */
export async function runIndexQueue(now = new Date(), { limit = WORKSPACE_INDEX_BATCH, budgetMs = 240_000 } = {}): Promise<Record<IndexOutcome, number>> {
  const started = Date.now();
  const stale = new Date(now.getTime() - WORKSPACE_INDEX_CLAIM_MS);
  const due = await db()
    .select({ id: schema.workspaceEntry.id })
    .from(schema.workspaceEntry)
    .where(and(isNull(schema.workspaceEntry.deletedAt), lte(schema.workspaceEntry.indexDueAt, now), or(isNull(schema.workspaceEntry.indexClaimedAt), lt(schema.workspaceEntry.indexClaimedAt, stale))))
    .orderBy(asc(schema.workspaceEntry.indexDueAt))
    .limit(limit);
  const counts: Record<IndexOutcome, number> = { indexed: 0, current: 0, dropped: 0, budget: 0, insufficient_credits: 0, retry: 0, skipped: 0 };
  for (const { id } of due) {
    if (Date.now() - started > budgetMs) break;
    counts[await indexEntry(id, now)] += 1;
  }
  return counts;
}

/* ------------------------------------------------------------------ search */

/**
 * `ws_search`: passages of indexed files below `path` that answer `query`,
 * by meaning (vectors in the question's space only) and by keyword, fused by
 * rank as Ree retrieval does. Free to the caller; files not indexed are not
 * searched (ws_grep reads every text file).
 */
export async function searchPassages(scope: WorkspaceScope, input: { query: string; path?: string; limit?: number }) {
  const query = input.query.trim();
  if (!query) throw new WorkspaceError('invalid_input', 'Give a question or words to search for.', { reason: 'empty_query' });
  const folder = resolvePath(scope, input.path ?? '/');
  const limit = Math.min(Math.max(input.limit ?? 10, 1), WORKSPACE_SEARCH_MAX);
  const asked = await embedQuestion(query);
  const literal = `[${asked.vector.join(',')}]`;
  const scopeSql = sql`p.workspace_id = ${scope.workspaceId} and e.deleted_at is null and ${within(folder, sql`e.path`)}`;
  const nearest = await db().execute<{ id: string; path: string; content: string; locator: { line?: number; heading?: string }; similarity: number }>(sql`
    select p.entry_id || ':' || p.ordinal as id, e.path, p.content, p.locator, 1 - (p.embedding <=> ${literal}::vector) as similarity
    from ${schema.workspacePassage} p join ${schema.workspaceEntry} e on e.id = p.entry_id
    where ${scopeSql} and p.embedding_space = ${asked.space}::uuid
    order by (p.embedding <=> ${literal}::vector) + 0, p.entry_id, p.ordinal
    limit 40`);
  const terms = searchTerms(query);
  const words = terms.length
    ? await db().execute<{ id: string; path: string; content: string; locator: { line?: number; heading?: string } }>(sql`
        select p.entry_id || ':' || p.ordinal as id, e.path, p.content, p.locator
        from ${schema.workspacePassage} p join ${schema.workspaceEntry} e on e.id = p.entry_id
        where ${scopeSql} and (${sql.join(terms.map((term) => sql`strpos(lower(p.content), ${term}) > 0`), sql` or `)})
        limit 400`)
    : { rows: [] };
  const byId = new Map<string, { path: string; content: string; locator: { line?: number; heading?: string }; similarity: number | null }>();
  for (const row of nearest.rows) byId.set(row.id, { ...row, similarity: Number(row.similarity) });
  for (const row of words.rows) if (!byId.has(row.id)) byId.set(row.id, { ...row, similarity: null });
  const keyword = words.rows.map((row) => ({ id: row.id, score: keywordCoverage(terms, row.content) })).filter((row) => row.score > 0).sort((a, b) => b.score - a.score).slice(0, 40);
  const order = fuse([nearest.rows.map((row) => ({ id: row.id, score: Number(row.similarity) })), keyword]).slice(0, limit);
  return {
    query,
    passages: order.map((id) => {
      const hit = byId.get(id)!;
      const first = hit.locator.line ?? 1;
      return {
        path: shown(scope, hit.path),
        lines: [first, first + hit.content.split('\n').length - 1],
        ...(hit.locator.heading ? { heading: hit.locator.heading } : {}),
        excerpt: hit.content.length > 600 ? `${hit.content.slice(0, 600)}…` : hit.content,
        similarity: hit.similarity,
      };
    }),
  };
}
