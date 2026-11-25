/**
 * The agent workspace's index (docs/design/agent-workspace.md §2.2, §5, §6):
 * which files are indexed, when, at what cost, and searching them.
 *
 * A file is indexed when its own `index_mode`, or the nearest folder's above
 * it that is not `inherit`, is `on`, or when a live Ree binds it (a binding
 * on it or a folder above it that does not exclude it). A save queues the
 * file two minutes ahead only when it may need the index or had one
 * (workspace.ts `putText`), so a burst of saves is indexed once and files
 * nobody indexes never enter the queue; the cron
 * (`/api/cron/workspace-index`, every minute) takes due files in turns
 * across workspaces and:
 *   1. cuts the text into passages by lines at content-defined points
 *      (`chunkFile`), each with the hash of its text alone (`content_digest`),
 *      so an edit changes only the passages around it;
 *   2. reuses the vector of every passage the workspace already holds in the
 *      current embedding space, and embeds only the rest -- recorded on the
 *      owner's metered run for the day (`workspace_index`), settled the next
 *      day at what the day cost, rounded up once, and reserved against the
 *      console's `workspaceIndexBudget` before each call;
 *   3. stores what it embedded at once (`PASSAGE_STAGED`), then swaps the
 *      file's passages in one transaction and records the version they index;
 *   4. once the run is over, brings the Rees those files are in up to date
 *      (workspace-rees.ts).
 * Nothing in a write request embeds or spends: a file over budget simply
 * waits for the next day, and `ws_grep` reads it meanwhile. After an
 * embedding-model switch, files indexed in the old space are queued again a
 * batch at a time and re-embedded within the budget; `ws_search` finds them
 * by keyword until then.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  CREDIT_USD,
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
import { closeMeteredRun, meterInto, openMeteredRun, openRunNamed, type MeteredRun, type MeteredWork } from '@/lib/services/metered-work';
import { providerPrices } from '@/lib/services/provider-pricing';
import { effectiveCeiling } from '@/lib/services/rate-limit-settings';
import { storingSpace } from '@/lib/services/reembed';
import { embedQuestion } from '@/lib/services/retrieval';
import { queueIndexWithin } from '@/lib/services/ree-file-guard';
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

/** The workspace's explicit index modes and the bindings of its live Rees (a deleted or taken-down Ree indexes nothing), for deciding about any number of its files. */
async function indexRules(executor: Executor, workspaceId: string) {
  const modes = await executor.execute<{ lower: string; mode: string }>(sql`
    select lower(path) as lower, index_mode as mode from ${schema.workspaceEntry}
    where workspace_id = ${workspaceId} and deleted_at is null and index_mode <> 'inherit'`);
  const bindings = await executor.execute<{ id: string; ree_id: string; path: string; lower: string; exclude: string[] }>(sql`
    select b.id, b.ree_id, e.path, lower(e.path) as lower, b.exclude from ${schema.reeBinding} b
    join ${schema.workspaceEntry} e on e.id = b.entry_id and e.deleted_at is null
    join ${schema.ree} r on r.id = b.ree_id and r.deleted_at is null and r.moderated_at is null
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

/**
 * Passage ordinals at and above these are a file's index being replaced:
 * `PASSAGE_SWAP` rows live only inside the transaction that swaps them in,
 * `PASSAGE_STAGED` rows are vectors already paid for and stored in their own
 * transaction, so a swap that fails is retried from them instead of paying
 * again. Searches and copies into Rees read below `PASSAGE_SWAP` only.
 */
export const PASSAGE_SWAP = 1_000_000;
export const PASSAGE_STAGED = 2_000_000;

/** What embedding `tokens` would cost: exact credits (fractions kept) and rounded up, or null when no price is known. */
async function price(tokens: number, endpoint: ModelEndpoint): Promise<{ exact: number | null; credits: number | null }> {
  if (tokens === 0) return { exact: 0, credits: 0 };
  const usd = await quoteProviderCost(modelCostTarget(endpoint, 'embedding'), await providerPrices(), { inputTokens: tokens });
  if (usd === null) return { exact: null, credits: null };
  return { exact: Number(usd) / CREDIT_USD, credits: providerTotal([{ costUsd: usd }]).credits };
}

const tokensOf = (texts: readonly string[]) => texts.reduce((sum, text) => sum + estimateTokens(text), 0);

/** The digests among `digests` the workspace holds a vector for in `space` (staged ones too: they are paid for). */
async function heldDigests(workspaceId: string, digests: readonly string[], space: string): Promise<Set<string>> {
  const held = new Set<string>();
  const unique = [...new Set(digests)];
  for (let at = 0; at < unique.length; at += 5_000) {
    const rows = await db()
      .selectDistinct({ digest: schema.workspacePassage.contentDigest })
      .from(schema.workspacePassage)
      .where(and(eq(schema.workspacePassage.workspaceId, workspaceId), eq(schema.workspacePassage.embeddingSpace, space), inArray(schema.workspacePassage.contentDigest, unique.slice(at, at + 5_000))));
    for (const row of rows) held.add(row.digest);
  }
  return held;
}

/** The passages indexing would embed: those whose digest the workspace does not hold in `space`, each once. */
function missingOf(passages: readonly DraftPassage[], held: ReadonlySet<string>, seen = new Set<string>()): string[] {
  return passages.filter((passage) => !held.has(passage.digest) && !seen.has(passage.digest) && seen.add(passage.digest)).map((passage) => passage.content);
}

export interface IndexEstimate {
  files: number;
  /** Files whose passages are all held already: indexing them is free. */
  reused: number;
  tokens: number;
  credits: number | null;
}

/** An estimate reads at most this much text in full; files past it are priced from their size, as if nothing in them were reused. */
const ESTIMATE_READ_BYTES = 8 * 1024 * 1024;
const ESTIMATE_PAGE = 200;

/** What indexing the text files at or below `path` would cost now (an upper bound: the passages to embed, at today's price), read a page at a time. */
export async function estimateIndex(scope: WorkspaceScope, rawPath: unknown): Promise<IndexEstimate> {
  const folder = resolvePath(scope, rawPath ?? '/');
  const endpoint = await endpointFor('embedding');
  const space = spaceOf(endpoint);
  const below = and(eq(schema.workspaceEntry.workspaceId, scope.workspaceId), isNull(schema.workspaceEntry.deletedAt), eq(schema.workspaceEntry.kind, 'file'), isNotNull(schema.workspaceEntry.text), within(folder));
  let files = 0;
  let reused = 0;
  let read = 0;
  let tokens = 0;
  let after: string | null = null;
  const seen = new Set<string>();
  for (;;) {
    const page: { id: string; size: number }[] = await db()
      .select({ id: schema.workspaceEntry.id, size: schema.workspaceEntry.size })
      .from(schema.workspaceEntry)
      .where(and(below, after ? gt(schema.workspaceEntry.id, after) : undefined))
      .orderBy(asc(schema.workspaceEntry.id))
      .limit(ESTIMATE_PAGE);
    if (page.length === 0) break;
    after = page.at(-1)!.id;
    files += page.length;
    const reading: string[] = [];
    for (const file of page) {
      if (read + file.size <= ESTIMATE_READ_BYTES) {
        reading.push(file.id);
        read += file.size;
      } else tokens += Math.ceil(file.size / 4);
    }
    if (reading.length === 0) continue;
    const texts = await db().select({ path: schema.workspaceEntry.path, text: schema.workspaceEntry.text }).from(schema.workspaceEntry).where(inArray(schema.workspaceEntry.id, reading));
    const drafts = texts.map((file) => passagesOf(file.path, file.text ?? ''));
    const held = await heldDigests(scope.workspaceId, drafts.flatMap((passages) => passages.map((passage) => passage.digest)), space);
    for (const passages of drafts) {
      if (passages.every((passage) => held.has(passage.digest))) reused += 1;
      tokens += tokensOf(missingOf(passages, held, seen));
    }
  }
  const { credits } = await price(tokens, endpoint);
  return { files, reused, tokens, credits };
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

const dayOf = (now: Date) => now.toISOString().slice(0, 10);

/** Today's index spending against the budget (credits, to two places: the day is billed as one run, rounded up once). */
export async function indexBudget(userId: string, now = new Date()) {
  const [row] = await db().select({ day: schema.workspaceUsage.indexSpentDay, spent: schema.workspaceUsage.indexSpent }).from(schema.workspaceUsage).where(eq(schema.workspaceUsage.userId, userId));
  const spent = row?.day === dayOf(now) ? row.spent : 0;
  return { spent: Math.ceil(spent * 100) / 100, budget: await effectiveCeiling('workspaceIndexBudget') };
}

/* ------------------------------------------------------------------ turning it on */

/**
 * `ws_index`: a file's or folder's index mode, and the text files at or
 * below it that may need the index (or had one) queued to be looked at now.
 * Turning it on quotes the cost first and refuses above `maxCost`
 * (`max_cost_exceeded`) before changing anything.
 */
export async function setIndexMode(scope: WorkspaceScope, input: { path: string; mode: 'on' | 'off' | 'inherit'; maxCost?: number }, now = new Date()) {
  requireWriteAccess(scope);
  const path = resolvePath(scope, input.path);
  const estimate = input.mode === 'on' ? await estimateIndex(scope, input.path) : null;
  if (estimate && input.maxCost !== undefined && (estimate.credits === null || estimate.credits > input.maxCost)) {
    throw new WorkspaceError('max_cost_exceeded', `Indexing ${shown(scope, path)} could cost up to ${estimate.credits ?? 'an unknown number of'} credits, above your max_cost of ${input.maxCost}. Nothing was changed.`, { estimate });
  }
  const entry = await existing(db(), scope, path);
  const queued = await db().transaction(async (tx) => {
    await tx.update(schema.workspaceEntry).set({ indexMode: input.mode }).where(eq(schema.workspaceEntry.id, entry.id));
    await tx.update(schema.workspaceEntry).set({ indexError: null }).where(and(eq(schema.workspaceEntry.workspaceId, scope.workspaceId), isNull(schema.workspaceEntry.deletedAt), eq(schema.workspaceEntry.kind, 'file'), isNotNull(schema.workspaceEntry.indexError), within(entry.path)));
    return queueIndexWithin(tx, scope.workspaceId, entry.path, now);
  });
  return { path: shown(scope, path), mode: input.mode, queued, estimate, budget: await indexBudget(scope.userId, now) };
}

/** Every text file at or below these entries that may need the index, or had one, looked at again now (a binding added or removed, a Ree deleted). */
export async function queueBelow(executor: Executor, workspaceId: string, paths: readonly string[], now = new Date()): Promise<void> {
  for (const path of paths) await queueIndexWithin(executor, workspaceId, path, now);
}

/* ------------------------------------------------------------------ the worker */

export type IndexOutcome = 'indexed' | 'current' | 'dropped' | 'unneeded' | 'budget' | 'insufficient_credits' | 'retry' | 'skipped';

const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const nextUtcDay = (now: Date) => new Date(startOfUtcDay(now).getTime() + 24 * 60 * 60_000);

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

/** Whether vectors `endpoint` makes now could be stored (its entry is still the enabled one): asked before paying for them. */
async function endpointCurrent(endpoint: ModelEndpoint): Promise<boolean> {
  const [row] = await db().select({ id: schema.modelConfig.id }).from(schema.modelConfig).where(and(eq(schema.modelConfig.kind, 'embedding'), eq(schema.modelConfig.enabled, true)));
  return (row?.id ?? null) === endpoint.configId;
}

/** Today's spending so far, as SQL on the usage row (a row from another day counts as nothing). */
const spentToday = (today: string) => sql`(case when ${schema.workspaceUsage.indexSpentDay} = ${today}::date then ${schema.workspaceUsage.indexSpent} else 0 end)`;

/**
 * Reserves `credits` of today's budget in one conditional update, so
 * workers running at once cannot pass the budget together: false when it
 * would go over.
 */
async function reserveBudget(userId: string, credits: number, now: Date): Promise<boolean> {
  const today = dayOf(now);
  const budget = await effectiveCeiling('workspaceIndexBudget');
  await db().insert(schema.workspaceUsage).values({ userId }).onConflictDoNothing();
  const rows = await db()
    .update(schema.workspaceUsage)
    .set({ indexSpent: sql`${spentToday(today)} + ${credits}::float8`, indexSpentDay: today })
    .where(and(eq(schema.workspaceUsage.userId, userId), sql`${spentToday(today)} + ${credits}::float8 <= ${budget}::float8`))
    .returning({ userId: schema.workspaceUsage.userId });
  return rows.length > 0;
}

/** A reservation the embedding did not use, given back (to today's budget only). */
async function giveBackBudget(userId: string, credits: number, now: Date): Promise<void> {
  await db()
    .update(schema.workspaceUsage)
    .set({ indexSpent: sql`greatest(0, ${schema.workspaceUsage.indexSpent} - ${credits}::float8)` })
    .where(and(eq(schema.workspaceUsage.userId, userId), eq(schema.workspaceUsage.indexSpentDay, dayOf(now))));
}

/**
 * Quotes are estimates (a supplier may count more tokens): once a call is
 * recorded, today's spending is raised to at least what the day's run has
 * actually recorded, so the budget never trails the bill.
 */
async function trueUpBudget(userId: string, run: MeteredRun, now: Date): Promise<void> {
  const [row] = await db().select({ charges: schema.knowledgeCostRun.charges }).from(schema.knowledgeCostRun).where(eq(schema.knowledgeCostRun.id, run.holdId));
  const recorded = (row?.charges ?? []).reduce((sum, charge) => sum + (charge.costUsd === null ? 0 : Number(charge.costUsd) / CREDIT_USD), 0);
  await db()
    .update(schema.workspaceUsage)
    .set({ indexSpent: sql`greatest(${schema.workspaceUsage.indexSpent}, ${recorded}::float8)` })
    .where(and(eq(schema.workspaceUsage.userId, userId), eq(schema.workspaceUsage.indexSpentDay, dayOf(now))));
}

const dayRunId = (userId: string, day: string) => `workspace-index:${userId}:${day}`;
const dayRunInput = (userId: string, day: string): MeteredWork => ({ userId, reeId: null, kind: 'workspace_index', title: `Workspace index ${day}`, reeName: '', refuse: true });

/**
 * The owner's indexing run for today: every embedding the index makes in a
 * UTC day is recorded on one metered run, settled the next day at what the
 * day cost, rounded up once -- so many small edits cost what they cost,
 * not a credit each.
 */
async function dayRun(userId: string, now: Date): Promise<MeteredRun> {
  const day = dayOf(now);
  const runId = dayRunId(userId, day);
  const input = dayRunInput(userId, day);
  const open = await openRunNamed(runId, input);
  if (open) return open;
  try {
    /* The ledger points at a uuid; the run's name is what finds it again today. */
    return await openMeteredRun(input, { runId, refId: crypto.randomUUID() }, now);
  } catch (error) {
    if (error instanceof InsufficientCredits) throw error;
    /* Another worker opened it first (the run id is unique), or today's run was closed early: use it, or start another. */
    return (await openRunNamed(runId, input)) ?? openMeteredRun(input, { runId: `${runId}:${now.getTime()}`, refId: crypto.randomUUID() }, now);
  }
}

/** Yesterday's (and older) index runs settled: what each day cost, charged once. Answers how many it closed. */
export async function closeIndexRuns(now = new Date(), limit = 200): Promise<number> {
  const rows = await db()
    .select({ id: schema.knowledgeCostRun.id, runId: schema.knowledgeCostRun.runId, userId: schema.knowledgeCostRun.userId, createdAt: schema.knowledgeCostRun.createdAt })
    .from(schema.knowledgeCostRun)
    .where(and(eq(schema.knowledgeCostRun.kind, 'workspace_index'), eq(schema.knowledgeCostRun.status, 'processing'), lt(schema.knowledgeCostRun.createdAt, startOfUtcDay(now))))
    .limit(limit);
  let closed = 0;
  for (const row of rows) {
    const run: MeteredRun = { holdId: row.id, runId: row.runId!, input: dayRunInput(row.userId, dayOf(row.createdAt)) };
    if ((await closeMeteredRun(run, null)) !== null) closed += 1;
  }
  return closed;
}

/** Freshly embedded vectors stored at once, in their own transaction, under `PASSAGE_STAGED`: paid for, so a retry reuses them. */
async function stage(entry: Entry, revisionId: string, contents: readonly string[], vectors: readonly number[][], endpoint: ModelEndpoint): Promise<boolean> {
  return db().transaction(async (tx) => {
    const storing = await storingSpace(tx, endpoint.configId);
    if (storing === null) return false;
    for (let at = 0; at < contents.length; at += 200) {
      await tx
        .insert(schema.workspacePassage)
        .values(
          contents.slice(at, at + 200).map((content, offset) => ({
            entryId: entry.id,
            ordinal: PASSAGE_STAGED + at + offset,
            workspaceId: entry.workspaceId,
            revisionId,
            content,
            locator: {},
            contentDigest: digestOf(content),
            embedding: vectors[at + offset]!,
            embeddingSpace: storing,
          })),
        )
        .onConflictDoUpdate({
          target: [schema.workspacePassage.entryId, schema.workspacePassage.ordinal],
          set: { revisionId: sql`excluded.revision_id`, content: sql`excluded.content`, contentDigest: sql`excluded.content_digest`, embedding: sql`excluded.embedding`, embeddingSpace: sql`excluded.embedding_space` },
        });
    }
    return true;
  });
}

/**
 * The file's index replaced by `passages`, every vector taken from one the
 * workspace holds (staged ones included), in one transaction: a search
 * reads the old index or the new, never half. False when the embedding
 * model changed meanwhile.
 */
async function swapIn(entry: Entry, revisionId: string, passages: readonly DraftPassage[], endpoint: ModelEndpoint): Promise<boolean> {
  return db().transaction(async (tx) => {
    const storing = await storingSpace(tx, endpoint.configId);
    if (storing === null) return false;
    for (let at = 0; at < passages.length; at += 200) {
      const slice = passages.slice(at, at + 200).map((passage) => ({ ordinal: passage.ordinal, content: passage.content, locator: passage.locator, digest: passage.digest }));
      await tx.execute(sql`
        insert into ${schema.workspacePassage} (entry_id, ordinal, workspace_id, revision_id, content, locator, content_digest, embedding, embedding_space)
        select ${entry.id}::uuid, d.ordinal + ${PASSAGE_SWAP}, ${entry.workspaceId}::uuid, ${revisionId}::uuid, d.content, d.locator, d.digest,
          (select p.embedding from ${schema.workspacePassage} p where p.workspace_id = ${entry.workspaceId}::uuid and p.content_digest = d.digest and p.embedding_space = ${storing}::uuid limit 1),
          ${storing}::uuid
        from jsonb_to_recordset(${JSON.stringify(slice)}::jsonb) as d(ordinal int, content text, locator jsonb, digest text)`);
    }
    await tx.delete(schema.workspacePassage).where(and(eq(schema.workspacePassage.entryId, entry.id), or(lt(schema.workspacePassage.ordinal, PASSAGE_SWAP), gte(schema.workspacePassage.ordinal, PASSAGE_STAGED))));
    await tx.update(schema.workspacePassage).set({ ordinal: sql`${schema.workspacePassage.ordinal} - ${PASSAGE_SWAP}` }).where(eq(schema.workspacePassage.entryId, entry.id));
    /* A save while this ran set a later due time: keep it, so that version is indexed in turn. */
    await tx
      .update(schema.workspaceEntry)
      .set({ indexedRevisionId: revisionId, indexClaimedAt: null, indexError: null, indexDueAt: sql`case when ${schema.workspaceEntry.currentRevisionId} = ${revisionId}::uuid then null else ${schema.workspaceEntry.indexDueAt} end` })
      .where(eq(schema.workspaceEntry.id, entry.id));
    return true;
  });
}

/** Indexes one due file (see the header); answers what happened. Rees follow in `runIndexQueue`, once per run. */
export async function indexEntry(entryId: string, now = new Date()): Promise<IndexOutcome> {
  const entry = await claim(entryId, now);
  if (!entry) return 'skipped';
  try {
    const rules = await indexRules(db(), entry.workspaceId);
    if (entry.kind !== 'file' || entry.text === null || !wanted(rules, entry)) {
      /* Not indexed (turned off, unbound, a folder, its Ree deleted): its passages go, and any Ree that had it lets it go. */
      await db().delete(schema.workspacePassage).where(eq(schema.workspacePassage.entryId, entry.id));
      await release(entry.id, { indexDueAt: null, indexError: null, indexedRevisionId: null });
      return entry.indexedRevisionId ? 'dropped' : 'unneeded';
    }
    const endpoint = await endpointFor('embedding');
    const space = spaceOf(endpoint);
    if (!(await endpointCurrent(endpoint))) {
      await release(entry.id, { indexDueAt: new Date(now.getTime() + 5 * 60_000) });
      return 'retry';
    }
    const revisionId = entry.currentRevisionId!;
    const passages = passagesOf(entry.path, entry.text);
    const missing = missingOf(passages, await heldDigests(entry.workspaceId, passages.map((passage) => passage.digest), space));
    /* Renamed since it was indexed: the passages are cut again under the new name (citations name the file), reusing every vector. */
    const [first] = await db().select({ name: sql<string | null>`${schema.workspacePassage.locator} ->> 'path'` }).from(schema.workspacePassage).where(and(eq(schema.workspacePassage.entryId, entry.id), eq(schema.workspacePassage.ordinal, 0)));
    const renamed = first !== undefined && first.name !== nameOf(entry.path);
    if (entry.indexedRevisionId === revisionId && missing.length === 0 && !renamed) {
      await db().delete(schema.workspacePassage).where(and(eq(schema.workspacePassage.entryId, entry.id), gte(schema.workspacePassage.ordinal, PASSAGE_SWAP)));
      await release(entry.id, { indexDueAt: null, indexError: null });
      return 'current';
    }
    if (missing.length) {
      const ownerId = await ownerOf(entry.workspaceId);
      const { exact } = await price(tokensOf(missing), endpoint);
      if (exact === null || !(await reserveBudget(ownerId, exact, now))) {
        /* Over today's budget (or no price to know): the file waits for tomorrow, and stays greppable. */
        await release(entry.id, { indexDueAt: nextUtcDay(now), indexError: 'budget' });
        return 'budget';
      }
      let run: MeteredRun;
      try {
        run = await dayRun(ownerId, now);
      } catch (error) {
        await giveBackBudget(ownerId, exact, now);
        if (error instanceof InsufficientCredits) {
          await release(entry.id, { indexDueAt: new Date(now.getTime() + 60 * 60_000), indexError: 'insufficient_credits' });
          return 'insufficient_credits';
        }
        throw error;
      }
      const outcome = await meterInto(run, () => embedTexts(missing, endpoint));
      if (!outcome.ok) {
        await giveBackBudget(ownerId, exact, now);
        if (outcome.error instanceof InsufficientCredits) {
          await release(entry.id, { indexDueAt: new Date(now.getTime() + 60 * 60_000), indexError: 'insufficient_credits' });
          return 'insufficient_credits';
        }
        throw outcome.error;
      }
      await trueUpBudget(ownerId, run, now);
      if (!(await stage(entry, revisionId, missing, outcome.value.vectors, endpoint))) {
        await release(entry.id, { indexDueAt: new Date(now.getTime() + 5 * 60_000) });
        return 'retry';
      }
    }
    if (!(await swapIn(entry, revisionId, passages, endpoint))) {
      /* The embedding model changed meanwhile: try again shortly, in the new space. */
      await release(entry.id, { indexDueAt: new Date(now.getTime() + 5 * 60_000) });
      return 'retry';
    }
    return 'indexed';
  } catch (error) {
    console.warn(`workspace index failed entry=${entry.id}`, error instanceof Error ? error.message : error);
    await release(entry.id, { indexDueAt: new Date(now.getTime() + 15 * 60_000), indexError: 'failed' });
    return 'retry';
  }
}

/**
 * After an embedding-model switch: indexed files whose passages are in
 * another space queued again, a batch a run, to be re-embedded within the
 * day's budget like any edit. Meanwhile `ws_search` still finds them by
 * keyword. Answers how many it queued.
 */
export async function queueStaleSpaces(now = new Date(), limit = WORKSPACE_INDEX_BATCH): Promise<number> {
  const space = spaceOf(await endpointFor('embedding'));
  /* The spaces passages are in, read by skipping along agent_workspace_passage_space_idx: one index probe per space. */
  const present = await db().execute<{ space: string }>(sql`
    with recursive s(space) as (
      (select embedding_space from ${schema.workspacePassage} order by embedding_space limit 1)
      union all
      select (select p.embedding_space from ${schema.workspacePassage} p where p.embedding_space > s.space order by p.embedding_space limit 1)
      from s where s.space is not null
    )
    select space from s where space is not null`);
  const others = present.rows.map((row) => row.space).filter((other) => other !== space);
  if (others.length === 0) return 0;
  const rows = await db().execute<{ id: string }>(sql`
    update ${schema.workspaceEntry} f set index_due_at = ${now.toISOString()}::timestamptz
    where f.id in (
      select p.entry_id from ${schema.workspacePassage} p
      join ${schema.workspaceEntry} e on e.id = p.entry_id and e.deleted_at is null and e.index_due_at is null
      where p.embedding_space in (${sql.join(others.map((other) => sql`${other}::uuid`), sql`, `)}) and p.ordinal < ${PASSAGE_SWAP}
      group by p.entry_id
      limit ${limit})
    returning f.id`);
  return rows.rows.length;
}

/** The Rees these files can be in, brought up to date with their index (loaded late: workspace-rees.ts imports this module). */
async function syncAfterIndex(workspaceId: string, entryIds: readonly string[]): Promise<void> {
  const { syncReesForEntries } = await import('@/lib/services/workspace-rees');
  await syncReesForEntries(workspaceId, entryIds);
}

/**
 * The cron's run: yesterday's index runs settled, files left in an old
 * embedding space queued, then due files taken in turns across workspaces
 * (each workspace's oldest first, so one busy account cannot hold up the
 * rest) until `budgetMs` is spent; the Rees the files are in follow once,
 * at the end.
 */
export async function runIndexQueue(now = new Date(), { limit = WORKSPACE_INDEX_BATCH, budgetMs = 240_000 } = {}): Promise<Record<IndexOutcome, number>> {
  const started = Date.now();
  await closeIndexRuns(now).catch((error) => console.warn('workspace index runs not closed', error instanceof Error ? error.message : error));
  await queueStaleSpaces(now).catch((error) => console.warn('workspace stale spaces not queued', error instanceof Error ? error.message : error));
  const stale = new Date(now.getTime() - WORKSPACE_INDEX_CLAIM_MS);
  const due = await db().execute<{ id: string; workspace_id: string }>(sql`
    select d.id, d.workspace_id from (
      select e.id, e.workspace_id, e.index_due_at,
        row_number() over (partition by e.workspace_id order by e.index_due_at, e.id) as turn
      from ${schema.workspaceEntry} e
      where e.deleted_at is null and e.index_due_at <= ${now.toISOString()}::timestamptz
        and (e.index_claimed_at is null or e.index_claimed_at < ${stale.toISOString()}::timestamptz)
    ) d
    order by d.turn, d.index_due_at, d.id
    limit ${limit}`);
  const counts: Record<IndexOutcome, number> = { indexed: 0, current: 0, dropped: 0, unneeded: 0, budget: 0, insufficient_credits: 0, retry: 0, skipped: 0 };
  const touched = new Map<string, string[]>();
  for (const row of due.rows) {
    if (Date.now() - started > budgetMs) break;
    const outcome = await indexEntry(row.id, now);
    counts[outcome] += 1;
    if (outcome === 'indexed' || outcome === 'current' || outcome === 'dropped') touched.set(row.workspace_id, [...(touched.get(row.workspace_id) ?? []), row.id]);
  }
  for (const [workspaceId, ids] of touched) {
    try {
      await syncAfterIndex(workspaceId, ids);
    } catch (error) {
      console.warn(`workspace ree sync failed workspace=${workspaceId}`, error instanceof Error ? error.message : error);
    }
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
    where ${scopeSql} and p.ordinal < ${PASSAGE_SWAP} and p.embedding_space = ${asked.space}::uuid
    order by (p.embedding <=> ${literal}::vector) + 0, p.entry_id, p.ordinal
    limit 40`);
  const terms = searchTerms(query);
  const words = terms.length
    ? await db().execute<{ id: string; path: string; content: string; locator: { line?: number; heading?: string } }>(sql`
        select p.entry_id || ':' || p.ordinal as id, e.path, p.content, p.locator
        from ${schema.workspacePassage} p join ${schema.workspaceEntry} e on e.id = p.entry_id
        where ${scopeSql} and p.ordinal < ${PASSAGE_SWAP} and (${sql.join(terms.map((term) => sql`strpos(lower(p.content), ${term}) > 0`), sql` or `)})
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
