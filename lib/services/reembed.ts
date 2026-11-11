/**
 * Switching the embedding model (2.5 "模型"): a full re-embed job.
 *
 * Every vector is tagged with its embedding space (embedding-space.ts), and
 * retrieval reads only the space its question was embedded in. Starting a
 * job changes nothing that answers: it gets a space of its own, and fills
 * each chunk's spare slot -- the one not holding the active space's vector --
 * with the candidate's vector in that space, in batches. Sources stored
 * meanwhile get the active model's vector only and join the queue. The last
 * step is one row: the candidate is enabled with the job's space, once no
 * chunk lacks a vector there and no source was stored since that was
 * checked. Nothing rewrites the chunks; vectors of spaces nothing uses any
 * more are cleared afterwards in small batches (`cleanupEmbeddingSpaces`).
 *
 * A failure leaves the old entry and space in use and keeps the
 * candidate's vectors: restarting the switch to the same, unedited entry
 * reuses the failed job's space, so it carries on where it stopped instead
 * of embedding (and billing) those passages again. A switch to any other
 * entry gets a new space and overwrites the spare slots as it goes. One job
 * at a time: no other embedding switch while one runs.
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
import { and, count, desc, eq, gt, isNull, lt, ne, not, or, sql, type SQL } from 'drizzle-orm';
import { REEMBED_BATCH, REEMBED_CLEANUP_BATCH, REEMBED_GRACE_MS, REEMBED_STEP_BUDGET_MS } from '@/lib/constants';
import { consoleEndpoint, embedTexts, forgetModelCache } from '@/lib/infra/ai/models';
import { db, schema, type Executor } from '@/lib/infra/db';
import { AdminInputError, audit } from '@/lib/services/admin';
import { activeSpace, BASE_SPACE, chunkHasSpace } from '@/lib/services/embedding-space';
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

/**
 * For a source about to store vectors made by `configId` (null: the
 * environment's model), in the caller's transaction: the space to tag them
 * with, or null when that entry is no longer the enabled one (the caller
 * embeds again). Counts the store on a running job (`arrived`), so the
 * switch can tell no source was stored since it last looked (`finish`).
 */
export async function storingSpace(executor: Executor, configId: string | null): Promise<string | null> {
  /* Shared with every other store, exclusive against the switch: see `finish`. */
  await executor.execute(sql`select pg_advisory_xact_lock_shared(hashtext('re0:embedding-switch'))`);
  const [row] = await executor
    .select({ id: schema.modelConfig.id, space: schema.modelConfig.embeddingSpace })
    .from(schema.modelConfig)
    .where(and(eq(schema.modelConfig.kind, 'embedding'), eq(schema.modelConfig.enabled, true)))
    .for('share');
  if ((row?.id ?? null) !== configId) return null;
  await executor
    .update(schema.reembedJob)
    .set({ arrived: sql`${schema.reembedJob.arrived} + 1` })
    .where(eq(schema.reembedJob.status, 'running'));
  return row?.space ?? BASE_SPACE;
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
     * its space is reused and they are kept (they were paid for). Otherwise
     * a new space; the old one's vectors are overwritten or cleaned up.
     */
    const [previous] = await tx.select().from(schema.reembedJob).orderBy(desc(schema.reembedJob.startedAt)).limit(1);
    const resumes = previous?.status === 'failed' && previous.toModelConfigId === toId && target.updatedAt.getTime() <= previous.startedAt.getTime();
    const space = resumes ? previous.space : crypto.randomUUID();
    const [kept] = resumes ? await tx.select({ n: count() }).from(schema.chunk).where(chunkHasSpace(space)) : [{ n: 0 }];
    const [job] = await tx
      .insert(schema.reembedJob)
      .values({ fromModelConfigId: active?.id ?? null, toModelConfigId: toId, space, total: chunks.n, done: kept?.n ?? 0, startedBy: administratorId, startedAt: now, heartbeatAt: RELEASED })
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
 * The switch, one row: the candidate becomes the enabled entry with the
 * job's space. `arrived` is the job's count of stored sources read before
 * the batch query that found no chunk lacking the job's space; if a source
 * was stored since, its chunks may lack it and the loop goes on (answers
 * false). Stores hold the switch lock shared and count themselves inside
 * it, so under the exclusive lock the count cannot move: what the batch
 * query saw is every chunk there is. No chunk is read or written here.
 */
async function finish(job: ReembedJob, arrived: number, now: Date): Promise<boolean> {
  const done = await db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('re0:embedding-switch'))`);
    const [previous] = await tx
      .select()
      .from(schema.modelConfig)
      .where(and(eq(schema.modelConfig.kind, 'embedding'), eq(schema.modelConfig.enabled, true)))
      .for('update');
    const [current] = await tx.select().from(schema.reembedJob).where(eq(schema.reembedJob.id, job.id)).for('update');
    if (current?.status !== 'running') return true;
    if (current.arrived !== arrived) return false;
    await tx
      .update(schema.modelConfig)
      .set({ enabled: false, updatedBy: job.startedBy, updatedAt: now })
      .where(and(eq(schema.modelConfig.kind, 'embedding'), ne(schema.modelConfig.id, job.toModelConfigId)));
    await tx
      .update(schema.modelConfig)
      .set({ enabled: true, embeddingSpace: current.space, updatedBy: job.startedBy, updatedAt: now })
      .where(eq(schema.modelConfig.id, job.toModelConfigId));
    await tx
      .update(schema.reembedJob)
      .set({ status: 'done', total: sql`greatest(${schema.reembedJob.total}, ${schema.reembedJob.done})`, finishedAt: now, heartbeatAt: now })
      .where(eq(schema.reembedJob.id, job.id));
    await audit(tx, {
      administratorId: job.startedBy,
      action: 'model.reembed.done',
      target: job.id,
      before: shown(previous),
      after: { to: job.toModelConfigId, space: current.space, chunks: current.done },
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
    await cleanupEmbeddingSpaces(deadline);
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
  const space = running.space;
  while (Date.now() < deadline) {
    /* Read before the batch query: `finish` switches only if no source was stored since (see there). */
    const [seen] = await database.select({ arrived: schema.reembedJob.arrived }).from(schema.reembedJob).where(eq(schema.reembedJob.id, running.id));
    const batch = await database
      .select({ id: schema.chunk.id, content: schema.chunk.content, ownerId: schema.ree.ownerId, reeName: schema.ree.name })
      .from(schema.chunk)
      .innerJoin(schema.ree, eq(schema.ree.id, schema.chunk.reeId))
      .where(not(chunkHasSpace(space)))
      /* Owner by owner, so a batch is one or two owners' passages, not one passage each of ninety-six. */
      .orderBy(schema.ree.ownerId, schema.chunk.id)
      .limit(REEMBED_BATCH);
    if (!batch.length) {
      if (await finish(running, seen?.arrived ?? 0, now())) {
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
        /* Into the spare slot: the one not holding the active space's vector, which answers keep reading. */
        const inUse = sql`(c.embedding is not null and coalesce(c.embedding_space, ${BASE_SPACE}::uuid) = ${activeSpace})`;
        await database.execute(sql`
          update ${schema.chunk} c set
            embedding = case when ${inUse} then c.embedding else v.e end,
            embedding_space = case when ${inUse} then c.embedding_space else ${space}::uuid end,
            embedding_next = case when ${inUse} then v.e else c.embedding_next end,
            embedding_next_space = case when ${inUse} then ${space}::uuid else c.embedding_next_space end
          from (values ${values}) as v(id, e)
          where c.id = v.id and not ${chunkHasSpace(space, 'c')}`);
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
 * not in the active space is rebuilt with the new model (as many as fit
 * before `deadline`; the next poll or cron run does the rest). Until then
 * explore leaves it out (it reads one space only).
 */
export async function rebuildProfiles(deadline: number): Promise<number> {
  const stale = await db()
    .selectDistinct({ reeId: schema.reeProfileVector.reeId })
    .from(schema.reeProfileVector)
    .where(sql`coalesce(${schema.reeProfileVector.embeddingSpace}, ${BASE_SPACE}::uuid) <> ${activeSpace}`);
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

/**
 * Clears vectors of spaces nothing reads any more, in batches of
 * `REEMBED_CLEANUP_BATCH` chunks until none is left or `deadline`. Kept: the
 * active space, a running job's, and the latest job's if it failed (a
 * restart reuses it). Nothing is cleared within `REEMBED_GRACE_MS` of a
 * switch: a question embedded just before it (or by an instance whose model
 * cache has not expired) still reads the old space. Each batch holds the
 * re-embed lock, so no job starts with a space the batch does not know, and
 * overlapping runs take turns; rows another transaction holds are skipped.
 * Answers how many chunks it cleaned.
 */
export async function cleanupEmbeddingSpaces(deadline = Date.now() + 60_000, now = () => new Date()): Promise<number> {
  let cleaned = 0;
  while (Date.now() < deadline) {
    const batch = await db().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('re0:reembed'))`);
      const [recent] = await tx
        .select({ id: schema.reembedJob.id })
        .from(schema.reembedJob)
        .where(and(eq(schema.reembedJob.status, 'done'), gt(schema.reembedJob.finishedAt, new Date(now().getTime() - REEMBED_GRACE_MS))))
        .limit(1);
      if (recent) return 0;
      const [{ active }] = (await tx.execute<{ active: string }>(sql`select ${activeSpace}::text as active`)).rows as [{ active: string }];
      const keep = [active];
      const [running] = await tx.select({ space: schema.reembedJob.space }).from(schema.reembedJob).where(eq(schema.reembedJob.status, 'running'));
      if (running) keep.push(running.space);
      const [latest] = await tx.select({ status: schema.reembedJob.status, space: schema.reembedJob.space }).from(schema.reembedJob).orderBy(desc(schema.reembedJob.startedAt)).limit(1);
      if (latest?.status === 'failed') keep.push(latest.space);
      const kept = sql`array[${sql.join(keep.map((space) => sql`${space}::uuid`), sql`, `)}]`;
      const stale0 = sql`(c.embedding is not null and coalesce(c.embedding_space, ${BASE_SPACE}::uuid) <> all(${kept}))`;
      const stale1 = sql`(c.embedding_next is not null and (c.embedding_next_space is null or c.embedding_next_space <> all(${kept})))`;
      const rows = await tx.execute(sql`
        update ${schema.chunk} c set
          embedding = case when ${stale0} then null else c.embedding end,
          embedding_space = case when ${stale0} then null else c.embedding_space end,
          embedding_next = case when ${stale1} then null else c.embedding_next end,
          embedding_next_space = case when ${stale1} then null else c.embedding_next_space end
        where c.id in (select c.id from ${schema.chunk} c where ${stale0} or ${stale1} limit ${REEMBED_CLEANUP_BATCH} for update skip locked)
        returning c.id`);
      return rows.rows.length;
    });
    cleaned += batch;
    if (batch < REEMBED_CLEANUP_BATCH) break;
  }
  return cleaned;
}
