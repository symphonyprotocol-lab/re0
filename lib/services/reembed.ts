/**
 * Switching the embedding model (2.5 "模型"): a full re-embed job.
 *
 * Starting it changes nothing that answers: the old entry stays enabled and
 * retrieval keeps reading `chunk.embedding`. The job fills
 * `chunk.embedding_next` with the candidate's vectors in batches -- sources
 * added meanwhile are embedded by the old model and simply join the queue --
 * and its last step, in one transaction that holds new chunks out, moves
 * every `embedding_next` into `embedding` and enables the candidate. Until
 * then the two sets of vectors live side by side; a failure clears the
 * candidate's vectors and leaves the old entry in use. One job at a time:
 * no other embedding switch while one runs.
 *
 * The work runs in `after()` steps of a few minutes each. The models page
 * polls progress, and a poll that finds the job without a recent heartbeat
 * starts the next step, so a job outlives any single function.
 */
import { and, count, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { REEMBED_BATCH, REEMBED_STEP_BUDGET_MS } from '@/lib/constants';
import { consoleEndpoint, embedTexts, forgetModelCache } from '@/lib/infra/ai/models';
import { db, schema, type Executor } from '@/lib/infra/db';
import { AdminInputError, audit } from '@/lib/services/admin';

export type ReembedJob = typeof schema.reembedJob.$inferSelect;

/** A running job whose last heartbeat is older than this is picked up by the next poll or cron run. */
export const REEMBED_STALL_MS = 45_000;

/** Whether vectors made by `configId` (null: the environment's model) still match the enabled embedding entry. */
export async function embeddingIsCurrent(executor: Executor, configId: string | null): Promise<boolean> {
  /* Shared with every other store, exclusive against the switch: see `finish`. */
  await executor.execute(sql`select pg_advisory_xact_lock_shared(hashtext('re0:embedding-switch'))`);
  const [row] = await executor
    .select({ id: schema.modelConfig.id })
    .from(schema.modelConfig)
    .where(and(eq(schema.modelConfig.kind, 'embedding'), eq(schema.modelConfig.enabled, true)))
    .for('share');
  return (row?.id ?? null) === configId;
}

export async function latestReembedJob(): Promise<(ReembedJob & { fromName: string | null; toName: string | null }) | null> {
  const name = (column: string) => sql<string | null>`(select m.name from ${schema.modelConfig} m where m.id = "reembed_job".${sql.raw(column)})`;
  const [row] = await db()
    .select({ job: schema.reembedJob, fromName: name('from_model_config_id'), toName: name('to_model_config_id') })
    .from(schema.reembedJob)
    .orderBy(desc(schema.reembedJob.startedAt))
    .limit(1);
  return row ? { ...row.job, fromName: row.fromName, toName: row.toName } : null;
}

export async function runningReembedJob(executor: Executor = db()): Promise<ReembedJob | null> {
  const [row] = await executor.select().from(schema.reembedJob).where(eq(schema.reembedJob.status, 'running')).limit(1);
  return row ?? null;
}

function shown(row: typeof schema.modelConfig.$inferSelect | undefined) {
  return row ? { id: row.id, name: row.name, model: row.model, transport: row.transport, baseUrl: row.baseUrl } : null;
}

/**
 * Creates the job for switching to `toId`. Answers `null` when there is
 * nothing to re-embed (no passages yet): the caller enables the entry directly.
 */
export async function startReembed(administratorId: string, toId: string, now = new Date()): Promise<ReembedJob | null> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('re0:reembed'))`);
    const [target] = await tx.select().from(schema.modelConfig).where(eq(schema.modelConfig.id, toId)).limit(1);
    if (!target || target.kind !== 'embedding') throw new AdminInputError('not_found');
    if (target.enabled) throw new AdminInputError('stale');
    if (await runningReembedJob(tx)) throw new AdminInputError('job_running');
    const [chunks] = await tx.select({ n: count() }).from(schema.chunk);
    if (!chunks?.n) return null;
    const [active] = await tx
      .select()
      .from(schema.modelConfig)
      .where(and(eq(schema.modelConfig.kind, 'embedding'), eq(schema.modelConfig.enabled, true)))
      .limit(1);
    /* Leftovers of a failed job are not the candidate's. */
    await tx.update(schema.chunk).set({ embeddingNext: null }).where(isNotNull(schema.chunk.embeddingNext));
    const [job] = await tx
      .insert(schema.reembedJob)
      .values({ fromModelConfigId: active?.id ?? null, toModelConfigId: toId, total: chunks.n, done: 0, startedBy: administratorId, startedAt: now, heartbeatAt: now })
      .returning();
    await audit(tx, { administratorId, action: 'model.reembed.start', target: job!.id, before: shown(active), after: { ...shown(target), total: chunks.n } });
    return job!;
  });
}

async function fail(job: ReembedJob, reason: string, now = new Date()): Promise<void> {
  const database = db();
  const [failed] = await database
    .update(schema.reembedJob)
    .set({ status: 'failed', error: reason.slice(0, 500), finishedAt: now })
    .where(and(eq(schema.reembedJob.id, job.id), eq(schema.reembedJob.status, 'running')))
    .returning({ id: schema.reembedJob.id });
  if (!failed) return;
  await database.update(schema.chunk).set({ embeddingNext: null }).where(isNotNull(schema.chunk.embeddingNext));
  await audit(database, { administratorId: job.startedBy, action: 'model.reembed.failed', target: job.id, after: { error: reason.slice(0, 500), done: job.done, total: job.total } });
}

/**
 * The switch: with new chunks held out, every passage must have its
 * candidate vector; then both columns and the enabled entry change together.
 * Answers false when passages arrived since the last batch (the loop goes on).
 */
async function finish(job: ReembedJob, now: Date): Promise<boolean> {
  const done = await db().transaction(async (tx) => {
    /*
     * Lock order matters: the switch lock first, then the passages. A source
     * being stored holds the switch lock shared before it inserts, so it
     * either finishes before this or waits and then sees the new model.
     */
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('re0:embedding-switch'))`);
    const [previous] = await tx
      .select()
      .from(schema.modelConfig)
      .where(and(eq(schema.modelConfig.kind, 'embedding'), eq(schema.modelConfig.enabled, true)))
      .for('update');
    await tx.execute(sql`lock table ${schema.chunk} in share row exclusive mode`);
    const [current] = await tx.select().from(schema.reembedJob).where(eq(schema.reembedJob.id, job.id)).for('update');
    if (current?.status !== 'running') return true;
    const [missing] = await tx.select({ n: count() }).from(schema.chunk).where(isNull(schema.chunk.embeddingNext));
    if (missing?.n) return false;
    await tx.execute(sql`update ${schema.chunk} set embedding = embedding_next, embedding_next = null`);
    await tx
      .update(schema.modelConfig)
      .set({ enabled: false, updatedBy: job.startedBy, updatedAt: now })
      .where(and(eq(schema.modelConfig.kind, 'embedding'), ne(schema.modelConfig.id, job.toModelConfigId)));
    await tx.update(schema.modelConfig).set({ enabled: true, updatedBy: job.startedBy, updatedAt: now }).where(eq(schema.modelConfig.id, job.toModelConfigId));
    const [total] = await tx.select({ n: count() }).from(schema.chunk);
    await tx
      .update(schema.reembedJob)
      .set({ status: 'done', done: total?.n ?? 0, total: total?.n ?? 0, finishedAt: now, heartbeatAt: now })
      .where(eq(schema.reembedJob.id, job.id));
    await audit(tx, {
      administratorId: job.startedBy,
      action: 'model.reembed.done',
      target: job.id,
      before: shown(previous),
      after: { to: job.toModelConfigId, chunks: total?.n ?? 0 },
    });
    return true;
  });
  if (done) forgetModelCache();
  return done;
}

/**
 * Works on the running job for up to `budgetMs`: batches of passages without
 * a candidate vector, then the switch. Safe to run twice at once -- the
 * worst case is a batch embedded twice.
 */
export async function runReembed(budgetMs = REEMBED_STEP_BUDGET_MS, now = () => new Date()): Promise<ReembedJob | null> {
  const database = db();
  const deadline = Date.now() + budgetMs;
  let job = await runningReembedJob();
  if (!job) return null;
  const [target] = await database.select().from(schema.modelConfig).where(eq(schema.modelConfig.id, job.toModelConfigId)).limit(1);
  if (!target) {
    await fail(job, 'candidate entry removed', now());
    return job;
  }
  const endpoint = await consoleEndpoint(target);
  while (Date.now() < deadline) {
    const [state] = await database.select().from(schema.reembedJob).where(eq(schema.reembedJob.id, job.id)).limit(1);
    if (state?.status !== 'running') return state ?? job;
    job = state;
    const batch = await database
      .select({ id: schema.chunk.id, content: schema.chunk.content })
      .from(schema.chunk)
      .where(isNull(schema.chunk.embeddingNext))
      .orderBy(schema.chunk.id)
      .limit(REEMBED_BATCH);
    if (!batch.length) {
      if (await finish(job, now())) break;
      continue;
    }
    let vectors: number[][];
    try {
      vectors = (await embedTexts(batch.map((row) => row.content), endpoint)).vectors;
    } catch (error) {
      await fail(job, error instanceof Error ? error.message : 'embedding failed', now());
      break;
    }
    const values = sql.join(
      batch.map((row, index) => sql`(${row.id}::uuid, ${JSON.stringify(vectors[index])}::vector)`),
      sql`, `,
    );
    await database.execute(sql`update ${schema.chunk} c set embedding_next = v.e from (values ${values}) as v(id, e) where c.id = v.id`);
    const [progress] = await database.select({ n: count() }).from(schema.chunk).where(isNotNull(schema.chunk.embeddingNext));
    const [total] = await database.select({ n: count() }).from(schema.chunk);
    await database
      .update(schema.reembedJob)
      .set({ done: progress?.n ?? 0, total: total?.n ?? 0, heartbeatAt: now() })
      .where(and(eq(schema.reembedJob.id, job.id), eq(schema.reembedJob.status, 'running')));
  }
  const [final] = await database.select().from(schema.reembedJob).where(eq(schema.reembedJob.id, job.id)).limit(1);
  return final ?? job;
}

/** Whether the running job has gone quiet long enough for a poll to start the next step. */
export function reembedStalled(job: ReembedJob, now = new Date()): boolean {
  return job.status === 'running' && now.getTime() - (job.heartbeatAt ?? job.startedAt).getTime() > REEMBED_STALL_MS;
}
