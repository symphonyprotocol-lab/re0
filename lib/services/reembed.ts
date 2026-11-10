/**
 * Switching the embedding model (2.5 "模型"): a full re-embed job.
 *
 * Starting it changes nothing that answers: the old entry stays enabled and
 * retrieval keeps reading `chunk.embedding`. The job fills
 * `chunk.embedding_next` with the candidate's vectors in batches -- sources
 * added meanwhile are embedded by the old model and simply join the queue --
 * and its last step, in one transaction that holds new chunks out, moves
 * every `embedding_next` into `embedding` and enables the candidate. Until
 * then the two sets of vectors live side by side; a failure leaves the old
 * entry in use and keeps the candidate's vectors made so far, so restarting
 * the switch to the same, unedited entry carries on where it stopped
 * instead of embedding (and billing) those passages again. Starting a switch
 * to any other entry clears them. One job at a time: no other embedding
 * switch while one runs.
 *
 * The work runs in `after()` steps of a few minutes each, one runner at a
 * time. A runner releases the job at the end of its step; the models page's
 * poll (or the cron) then starts the next step, and takes over a job whose
 * runner went silent, so a job outlives any single function. After the
 * switch, step 4's knowledge profiles are rebuilt with the new model.
 *
 * Billing (docs/audit/credit-import-audit.md P3): each knowledge-base owner
 * pays for their own passages. Batches are taken owner by owner, each
 * owner's passages are embedded in their own calls, and every receipt goes
 * on ONE metered run per owner per job (`reembed:<job>:<owner>`), settled
 * once when the job is over -- so an owner is charged the job's whole cost
 * rounded up once, never once per batch. The switch must complete, so a
 * call is never refused for want of credits: what a balance cannot cover is
 * owed. A candidate model without a price fails the job rather than run
 * unbilled. A failed job is settled at what it spent (P1); its vectors are
 * kept for a restart (above), so nobody pays twice for the same passage.
 */
import { and, count, desc, eq, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { REEMBED_BATCH, REEMBED_STEP_BUDGET_MS } from '@/lib/constants';
import { consoleEndpoint, embedTexts, forgetModelCache } from '@/lib/infra/ai/models';
import { db, schema, type Executor } from '@/lib/infra/db';
import { AdminInputError, audit } from '@/lib/services/admin';
import { closeMeteredRun, meterInto, openMeteredRun, openRunNamed, type MeteredRun, type MeteredWork } from '@/lib/services/metered-work';
import { refreshProfile } from '@/lib/services/profile';

export type ReembedJob = typeof schema.reembedJob.$inferSelect;

/**
 * A running job whose runner has been silent this long is taken over by the
 * next poll or cron run. Longer than one embed call can take (the longest
 * model timeout plus retries); a runner that ends its step normally releases
 * the job at once instead.
 */
export const REEMBED_STALL_MS = 6 * 60_000;
/** The heartbeat a released job carries: stale, so the next poll picks it up. */
const RELEASED = new Date(0);

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
    /*
     * Vectors left by the last job are the candidate's only when that job
     * failed switching to this same entry, unedited since it started: then
     * they are kept (and were paid for). Anything else is cleared.
     */
    const [previous] = await tx.select().from(schema.reembedJob).orderBy(desc(schema.reembedJob.startedAt)).limit(1);
    const resumes = previous?.status === 'failed' && previous.toModelConfigId === toId && target.updatedAt.getTime() <= previous.startedAt.getTime();
    if (!resumes) await tx.update(schema.chunk).set({ embeddingNext: null }).where(isNotNull(schema.chunk.embeddingNext));
    const [kept] = resumes ? await tx.select({ n: count() }).from(schema.chunk).where(isNotNull(schema.chunk.embeddingNext)) : [{ n: 0 }];
    const [job] = await tx
      .insert(schema.reembedJob)
      .values({ fromModelConfigId: active?.id ?? null, toModelConfigId: toId, total: chunks.n, done: kept?.n ?? 0, startedBy: administratorId, startedAt: now, heartbeatAt: RELEASED })
      .returning();
    await audit(tx, { administratorId, action: 'model.reembed.start', target: job!.id, before: shown(active), after: { ...shown(target), total: chunks.n, kept: kept?.n ?? 0 } });
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
  /* The candidate's vectors stay for a restart (see `startReembed`); what the job spent is settled by `settleReembedRuns`. */
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
    /*
     * One statement, on purpose: done in batches, answers between them would
     * compare a question against vectors of two models. Kept cheap by having
     * no vector index on `chunk` to rebuild (migration 0038).
     */
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
 * Claims the running job for one runner: only a released or silent job can
 * be claimed, and only one claimant wins. Answers the lease (the heartbeat
 * written), which the runner renews before each batch; a renewal that finds
 * another lease means the job was taken over and this runner stops.
 */
/** The run an owner's re-embedding is billed on for one job. */
const runName = (jobId: string, ownerId: string) => `reembed:${jobId}:${ownerId}`;

async function ownerRun(job: ReembedJob, ownerId: string, reeNames: string[]): Promise<MeteredRun> {
  const input: MeteredWork = { userId: ownerId, reeId: null, kind: 'reembed', title: 'Embedding model switch', reeName: reeNames.join(', ').slice(0, 300), refuse: false };
  const name = runName(job.id, ownerId);
  const open = await openRunNamed(name, input);
  if (open) return open;
  try {
    return await openMeteredRun(input, { runId: name, refId: job.id });
  } catch (error) {
    /* A runner that took the job over opened it meanwhile (unique run id). */
    const raced = await openRunNamed(name, input);
    if (raced) return raced;
    throw error;
  }
}

/**
 * Settles every owner's run of each job that is no longer running, at what
 * it recorded, once (`closeMeteredRun`): `ready` after a switch, `failed`
 * after a failure (what was spent is charged, P1). Runs as many as fit
 * before `deadline`; the next poll or cron run does the rest. Answers how
 * many it closed.
 */
export async function settleReembedRuns(deadline = Date.now() + 60_000): Promise<number> {
  const open = await db().execute<{ id: string; run_id: string; user_id: string; ree_name: string; title: string; job_status: string }>(sql`
    select r.id, r.run_id, r.user_id, r.ree_name, r.title, j.status as job_status
    from ${schema.knowledgeCostRun} r
    join ${schema.reembedJob} j on r.run_id like 'reembed:' || j.id::text || ':%'
    where r.kind = 'reembed' and r.status = 'processing' and j.status <> 'running'
    order by r.created_at
    limit 1000`);
  let closed = 0;
  for (const row of open.rows) {
    if (Date.now() >= deadline) break;
    const input: MeteredWork = { userId: row.user_id, reeId: null, kind: 'reembed', title: row.title, reeName: row.ree_name, refuse: false };
    if ((await closeMeteredRun({ holdId: row.id, runId: row.run_id, input }, row.job_status === 'done' ? null : 'failed')) !== null) closed += 1;
  }
  return closed;
}

async function claim(jobId: string, now: Date): Promise<Date | null> {
  const [row] = await db()
    .update(schema.reembedJob)
    .set({ heartbeatAt: now })
    .where(
      and(
        eq(schema.reembedJob.id, jobId),
        eq(schema.reembedJob.status, 'running'),
        or(isNull(schema.reembedJob.heartbeatAt), lt(schema.reembedJob.heartbeatAt, new Date(now.getTime() - REEMBED_STALL_MS))),
      ),
    )
    .returning({ id: schema.reembedJob.id });
  return row ? now : null;
}

async function renew(jobId: string, lease: Date, next: Date, progress: { done?: SQL } = {}): Promise<boolean> {
  const rows = await db()
    .update(schema.reembedJob)
    .set({ heartbeatAt: next, ...progress })
    .where(and(eq(schema.reembedJob.id, jobId), eq(schema.reembedJob.status, 'running'), eq(schema.reembedJob.heartbeatAt, lease)))
    .returning({ id: schema.reembedJob.id });
  return rows.length > 0;
}

/**
 * Works on the running job for up to `budgetMs`: batches of passages without
 * a candidate vector, then the switch, then the knowledge profiles. One
 * runner at a time (`claim`); at the end of its budget it releases the job
 * for the next poll or cron run.
 */
export async function runReembed(budgetMs = REEMBED_STEP_BUDGET_MS, now = () => new Date()): Promise<ReembedJob | null> {
  const database = db();
  const deadline = Date.now() + budgetMs;
  const running = await runningReembedJob();
  if (!running) {
    await settleReembedRuns(deadline);
    await rebuildProfiles(deadline);
    return null;
  }
  let lease = await claim(running.id, now());
  if (!lease) return running;
  const [target] = await database.select().from(schema.modelConfig).where(eq(schema.modelConfig.id, running.toModelConfigId)).limit(1);
  if (!target) {
    await fail(running, 'candidate entry removed', now());
    return running;
  }
  const endpoint = await consoleEndpoint(target);
  let finished = false;
  while (Date.now() < deadline) {
    const batch = await database
      .select({ id: schema.chunk.id, content: schema.chunk.content, ownerId: schema.ree.ownerId, reeName: schema.ree.name })
      .from(schema.chunk)
      .innerJoin(schema.ree, eq(schema.ree.id, schema.chunk.reeId))
      .where(isNull(schema.chunk.embeddingNext))
      /* Owner by owner, so a batch is one or two owners' passages, not one passage each of ninety-six. */
      .orderBy(schema.ree.ownerId, schema.chunk.id)
      .limit(REEMBED_BATCH);
    if (!batch.length) {
      if (await finish(running, now())) {
        finished = true;
        break;
      }
      continue;
    }
    /* Renew before the slow part, so nobody takes over while this batch is embedded. */
    const next = now();
    if (!(await renew(running.id, lease, next))) return running;
    lease = next;
    try {
      const owners = new Map<string, typeof batch>();
      for (const row of batch) owners.set(row.ownerId, [...(owners.get(row.ownerId) ?? []), row]);
      for (const [ownerId, rows] of owners) {
        const run = await ownerRun(running, ownerId, [...new Set(rows.map((row) => row.reeName))]);
        const embedded = await meterInto(run, () => embedTexts(rows.map((row) => row.content), endpoint));
        if (!embedded.ok) throw embedded.error;
        /* Stored owner by owner: a later owner's failure never discards (and so re-bills) vectors already paid for. */
        const values = sql.join(
          rows.map((row, index) => sql`(${row.id}::uuid, ${JSON.stringify(embedded.value.vectors[index])}::vector)`),
          sql`, `,
        );
        await database.execute(sql`update ${schema.chunk} c set embedding_next = v.e from (values ${values}) as v(id, e) where c.id = v.id`);
      }
    } catch (error) {
      await fail(running, error instanceof Error ? error.message : 'embedding failed', now());
      break;
    }
    /* Counted as it goes; `finish` recounts once. Passages added meanwhile can push `done` past the first total. */
    const after = now();
    if (!(await renew(running.id, lease, after, { done: sql`${schema.reembedJob.done} + ${batch.length}` }))) return running;
    lease = after;
  }
  if (finished) {
    await settleReembedRuns(deadline);
    await rebuildProfiles(deadline);
  } else if ((await runningReembedJob())?.id !== running.id) await settleReembedRuns(deadline);
  else await database.update(schema.reembedJob).set({ heartbeatAt: RELEASED }).where(and(eq(schema.reembedJob.id, running.id), eq(schema.reembedJob.heartbeatAt, lease)));
  const [final] = await database.select().from(schema.reembedJob).where(eq(schema.reembedJob.id, running.id)).limit(1);
  return final ?? running;
}

/**
 * Step 4's knowledge profiles hold vectors too: after a switch, every profile
 * older than the last completed job is rebuilt with the new model (as many as
 * fit before `deadline`; the next poll or cron run does the rest).
 */
export async function rebuildProfiles(deadline: number): Promise<number> {
  const [last] = await db()
    .select({ finishedAt: schema.reembedJob.finishedAt })
    .from(schema.reembedJob)
    .where(eq(schema.reembedJob.status, 'done'))
    .orderBy(desc(schema.reembedJob.finishedAt))
    .limit(1);
  if (!last?.finishedAt) return 0;
  const stale = await db()
    .selectDistinct({ reeId: schema.reeProfileVector.reeId })
    .from(schema.reeProfileVector)
    .where(lt(schema.reeProfileVector.updatedAt, last.finishedAt));
  let rebuilt = 0;
  for (const { reeId } of stale) {
    if (Date.now() >= deadline) break;
    try {
      await refreshProfile(reeId);
      rebuilt += 1;
    } catch (error) {
      console.warn(`profile rebuild after re-embed failed ree=${reeId}`, error instanceof Error ? error.message : error);
    }
  }
  return rebuilt;
}

/** Whether the running job has gone quiet long enough for a poll to start the next step. */
export function reembedStalled(job: ReembedJob, now = new Date()): boolean {
  return job.status === 'running' && now.getTime() - (job.heartbeatAt ?? job.startedAt).getTime() > REEMBED_STALL_MS;
}
