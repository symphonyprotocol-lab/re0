/**
 * Rees: the owner's list, the setup draft, creation from the draft, settings
 * and soft deletion (rebuild-proposal.md 3, 8.2).
 */
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { REE_PAGE_SIZES } from '@/lib/constants';
import { clampPage, likePattern, type ListResult } from '@/lib/domain/list';
import {
  coerceDraft,
  newReeDraft,
  randomSlug,
  REE_BATCH_MAX,
  reeValues,
  validateDraftSource,
  validateReeFields,
  type DraftSource,
  type ReeDraft,
  type ReeFieldError,
  type ReeFields,
  type SourceError,
  type VisibilityPlan,
  visibilityPlan,
} from '@/lib/domain/ree';
import { db, schema, type Executor, type Tx } from '@/lib/infra/db';
import { detachRee } from '@/lib/services/conversations';
import { checkKnowledge, createKnowledgeInTx, type NewKnowledge } from '@/lib/services/knowledge';

export type Ree = typeof schema.ree.$inferSelect;

export const REE_VISIBILITIES = ['all', 'public', 'private'] as const;
export const REE_SORTS = [
  'default',
  'name_asc',
  'name_desc',
  'sources_desc',
  'sources_asc',
  'answers_desc',
  'answers_asc',
] as const;
export type ReeVisibility = (typeof REE_VISIBILITIES)[number];
export type ReeSort = (typeof REE_SORTS)[number];

export interface ReeListItem {
  id: string;
  name: string;
  slug: string;
  description: string;
  avatarBlob: string | null;
  color: string;
  category: string;
  tags: string[];
  isPublic: boolean;
  /** Taken down by an administrator: shown as "已下架" and never made public by the owner (2.5). */
  moderatedAt: Date | null;
  sources: number;
  readySources: number;
  answers: number;
  createdAt: Date;
}

/**
 * Per-Ree counts, as SQL expressions: sources (any status, trash excluded),
 * ready sources (enabled ones only: a paused source is not ready, prototype
 * workspace.js `sourceSummary`), successful answers. An answer is a
 * `query_base` settlement in the ledger, one per answering Ree per question --
 * the same source as the statistics (statistics.ts `answerCounts`), so
 * clearing a test conversation keeps the count. The outer column is written
 * out qualified: drizzle renders a column inside a select list unqualified,
 * and a bare "id" would bind to the subquery's own table.
 */
const reeId = sql.raw('"ree"."id"');
const sourcesCount = sql<number>`(select count(*)::int from ${schema.knowledge} k where k.ree_id = ${reeId} and k.deleted_at is null)`;
const readyCount = sql<number>`(select count(*)::int from ${schema.knowledge} k where k.ree_id = ${reeId} and k.deleted_at is null and k.enabled and k.status = 'ready')`;
const answersCount = sql<number>`(select count(distinct ce.ref_id)::int from ${schema.creditEntry} ce where ce.ree_id = ${reeId} and ce.reason = 'query_base')`;

function ownedLive(ownerId: string): SQL {
  return and(eq(schema.ree.ownerId, ownerId), isNull(schema.ree.deletedAt))!;
}

/** The owner's live Rees matching the search and the visibility filter. */
function listWhere(ownerId: string, query: { q: string; visibility: ReeVisibility }): SQL {
  const conditions: SQL[] = [ownedLive(ownerId)];
  if (query.visibility === 'public') conditions.push(eq(schema.ree.isPublic, true));
  if (query.visibility === 'private') conditions.push(eq(schema.ree.isPublic, false));
  if (query.q) {
    const pattern = likePattern(query.q);
    conditions.push(
      or(
        ilike(schema.ree.name, pattern),
        ilike(schema.ree.description, pattern),
        sql`exists (select 1 from unnest(${schema.ree.tags}) tag where tag ilike ${pattern})`,
      )!,
    );
  }
  return and(...conditions)!;
}

export async function listRees(
  ownerId: string,
  query: { q: string; visibility: ReeVisibility; sort: ReeSort; size: number; page: number },
): Promise<ListResult<ReeListItem>> {
  const where = listWhere(ownerId, query);
  const database = db();
  const [{ total } = { total: 0 }] = await database
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.ree)
    .where(where);
  const size = (REE_PAGE_SIZES as readonly number[]).includes(query.size) ? query.size : REE_PAGE_SIZES[0];
  const page = clampPage(query.page, total, size);
  const name = sql`lower(${schema.ree.name})`;
  const order = {
    default: [desc(schema.ree.createdAt)],
    name_asc: [asc(name), asc(schema.ree.createdAt)],
    name_desc: [desc(name), asc(schema.ree.createdAt)],
    sources_desc: [desc(sourcesCount), desc(schema.ree.createdAt)],
    sources_asc: [asc(sourcesCount), desc(schema.ree.createdAt)],
    answers_desc: [desc(answersCount), desc(schema.ree.createdAt)],
    answers_asc: [asc(answersCount), desc(schema.ree.createdAt)],
  }[query.sort];
  const items = await database
    .select({
      id: schema.ree.id,
      name: schema.ree.name,
      slug: schema.ree.slug,
      description: schema.ree.description,
      avatarBlob: schema.ree.avatarBlob,
      color: schema.ree.color,
      category: schema.ree.category,
      tags: schema.ree.tags,
      isPublic: schema.ree.isPublic,
      moderatedAt: schema.ree.moderatedAt,
      sources: sourcesCount,
      readySources: readyCount,
      answers: answersCount,
      createdAt: schema.ree.createdAt,
    })
    .from(schema.ree)
    .where(where)
    .orderBy(...order)
    .limit(size)
    .offset((page - 1) * size);
  return { items, total, page, size };
}

/** Whole-collection figures for the page header and the dashboard; they ignore search and paging. */
export async function reeTotals(ownerId: string) {
  const [row] = await db()
    .select({
      rees: sql<number>`count(*)::int`,
      public: sql<number>`count(*) filter (where ${schema.ree.isPublic})::int`,
      sources: sql<number>`coalesce(sum(${sourcesCount}), 0)::int`,
      readySources: sql<number>`coalesce(sum(${readyCount}), 0)::int`,
      answers: sql<number>`coalesce(sum(${answersCount}), 0)::int`,
    })
    .from(schema.ree)
    .where(ownedLive(ownerId));
  const totals = row ?? { rees: 0, public: 0, sources: 0, readySources: 0, answers: 0 };
  return { ...totals, private: totals.rees - totals.public };
}

/** Live sources of one Ree, any status, trash excluded: the knowledge tab's count and the settings summary. */
export async function reeSourceCount(id: string): Promise<number> {
  const [row] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.knowledge)
    .where(and(eq(schema.knowledge.reeId, id), isNull(schema.knowledge.deletedAt)));
  return row?.count ?? 0;
}

export interface ReeSelectionItem {
  id: string;
  name: string;
  isPublic: boolean;
  moderated: boolean;
}

/**
 * "选中全部 N 个结果": every Ree the list's search and filter match (sort and
 * paging do not matter), with what the batch review needs, at most
 * `REE_BATCH_MAX`.
 */
export async function reeSelection(ownerId: string, query: { q: string; visibility: ReeVisibility }): Promise<ReeSelectionItem[]> {
  return db()
    .select({
      id: schema.ree.id,
      name: schema.ree.name,
      isPublic: schema.ree.isPublic,
      moderated: sql<boolean>`(${schema.ree.moderatedAt} is not null)`,
    })
    .from(schema.ree)
    .where(listWhere(ownerId, query))
    .orderBy(desc(schema.ree.createdAt))
    .limit(REE_BATCH_MAX);
}

/** Just the number of live Rees, for the sidebar on every page. */
export async function reeCount(ownerId: string): Promise<number> {
  const [row] = await db().select({ count: sql<number>`count(*)::int` }).from(schema.ree).where(ownedLive(ownerId));
  return row?.count ?? 0;
}

/** The owner's live Ree, or null for anyone else's, a deleted one, or a malformed id. */
export async function ownedRee(executor: Executor, ownerId: string, id: string): Promise<Ree | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await executor
    .select()
    .from(schema.ree)
    .where(and(eq(schema.ree.id, id), ownedLive(ownerId)))
    .limit(1);
  return row ?? null;
}

/* ------------------------------------------------------------------- draft */

export async function getDraft(userId: string): Promise<ReeDraft | null> {
  const [row] = await db().select({ draft: schema.user.reeDraft }).from(schema.user).where(eq(schema.user.id, userId));
  return row?.draft ? coerceDraft(row.draft) : null;
}

export async function saveDraft(userId: string, input: unknown): Promise<ReeDraft> {
  const draft = coerceDraft(input);
  await db().update(schema.user).set({ reeDraft: draft }).where(eq(schema.user.id, userId));
  return draft;
}

export async function clearDraft(userId: string): Promise<ReeDraft> {
  await db().update(schema.user).set({ reeDraft: null }).where(eq(schema.user.id, userId));
  return newReeDraft();
}

function draftFields(draft: ReeDraft): ReeFields & { isPublic: boolean; color: unknown } {
  return {
    name: draft.name,
    description: draft.description,
    category: draft.category,
    tags: draft.tags,
    systemPrompt: draft.systemPrompt,
    sampleQuestions: draft.sampleQuestions,
    queryFee: draft.queryFee,
    isPublic: draft.isPublic,
    color: draft.color,
  };
}

export class ReeInputError extends Error {
  constructor(
    readonly field: ReeFieldError | SourceError,
    readonly step: number,
  ) {
    super(field);
    this.name = 'ReeInputError';
  }
}

async function insertRee(tx: Tx, ownerId: string, values: ReturnType<typeof reeValues>, avatarBlob: string | null): Promise<Ree> {
  /* A slug clash is one in 36^8; retry rather than check first. */
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = randomSlug();
    const [clash] = await tx.select({ id: schema.ree.id }).from(schema.ree).where(eq(schema.ree.slug, slug)).limit(1);
    if (clash) continue;
    const [row] = await tx
      .insert(schema.ree)
      .values({ ownerId, slug, avatarBlob, ...values })
      .returning();
    return row!;
  }
  throw new Error('could not find a free slug');
}

/** The wizard's first source as a knowledge submission, or null for "稍后添加". */
export function draftKnowledge(source: DraftSource): NewKnowledge | null {
  switch (source.kind) {
    case 'later':
      return null;
    case 'document':
      return { kind: 'document', blobPath: source.blobPath, fileName: source.fileName };
    case 'audio':
      return { kind: 'audio', blobPath: source.blobPath, fileName: source.fileName, consent: source.consent };
    case 'text':
      return { kind: 'text', title: source.title, content: source.text };
    case 'github':
    case 'page':
    case 'site':
      return { kind: source.kind, url: source.url };
  }
}

/**
 * The part of a first source's check that needs the network -- a private
 * repository's GitHub connection, a website's verified domain -- run when
 * the wizard leaves step 3, so the owner is told there and not at the end.
 */
export async function checkDraftSource(ownerId: string, source: DraftSource): Promise<void> {
  if (source.kind !== 'github' && source.kind !== 'site') return;
  await checkKnowledge(ownerId, draftKnowledge(source)!);
}

/**
 * The wizard's final confirmation: the only moment a Ree is created. The
 * first source, when there is one, is created in the same transaction with
 * its processing hold -- not enough credits and nothing is created at all.
 */
export async function createReeFromDraft(ownerId: string): Promise<{ ree: Ree; knowledgeId: string | null }> {
  const draft = await getDraft(ownerId);
  if (!draft) throw new ReeInputError('name', 1);
  const invalid = validateReeFields(draftFields(draft), 4);
  if (invalid) throw new ReeInputError(invalid.error, invalid.step);
  const sourceError = validateDraftSource(draft.source);
  if (sourceError) throw new ReeInputError(sourceError, 3);

  const source = draftKnowledge(draft.source);
  /* The upload is checked against Blob before the transaction opens. */
  const checked = source ? await checkKnowledge(ownerId, source) : null;

  return db().transaction(async (tx) => {
    const avatar = draft.avatarBlob?.startsWith(`avatars/${ownerId}/`) ? draft.avatarBlob : null;
    const ree = await insertRee(tx, ownerId, reeValues(draftFields(draft)), avatar);
    let knowledgeId: string | null = null;
    if (checked) knowledgeId = await createKnowledgeInTx(tx, ownerId, ree, checked);
    await tx.update(schema.user).set({ reeDraft: null }).where(eq(schema.user.id, ownerId));
    return { ree, knowledgeId };
  });
}

export async function updateRee(
  ownerId: string,
  id: string,
  fields: ReeFields & { isPublic: boolean; color: unknown; avatarBlob: string | null },
): Promise<Ree | null> {
  const invalid = validateReeFields(fields, 4);
  if (invalid) throw new ReeInputError(invalid.error, invalid.step);
  const avatarBlob = fields.avatarBlob && fields.avatarBlob.startsWith(`avatars/${ownerId}/`) ? fields.avatarBlob : null;
  return db().transaction(async (tx) => {
    const [row] = await tx
      .update(schema.ree)
      /* A Ree an administrator took down stays private until it is restored (2.5). */
      .set({ ...reeValues(fields), isPublic: sql`(${fields.isPublic} and "ree"."moderated_at" is null)`, avatarBlob, updatedAt: new Date() })
      .where(and(eq(schema.ree.id, id), ownedLive(ownerId)))
      .returning();
    /* Private now: out of other people's conversations and out of discovery (8.2); the history stays. */
    if (row && !row.isPublic) await hide(tx, row.id, { includeOwner: false });
    return row ?? null;
  });
}

/**
 * "设为公开 / 设为私有" for many Rees at once (prototype owned-rees.js
 * `batchVisibility`): the owner's live Rees are locked and planned again,
 * those already at the target are left alone and a taken-down Ree is
 * skipped when going public -- the same rule as `updateRee`. Going private
 * leaves other people's conversations and discovery exactly as the single
 * update does. Only visibility changes; knowledge, videos, conversations,
 * billing and statistics stay.
 */
export async function setReesVisibility(ownerId: string, ids: readonly string[], isPublic: boolean): Promise<VisibilityPlan> {
  return db().transaction(async (tx) => {
    const rows = await tx
      .select({ id: schema.ree.id, isPublic: schema.ree.isPublic, moderatedAt: schema.ree.moderatedAt })
      .from(schema.ree)
      .where(and(inArray(schema.ree.id, [...ids]), ownedLive(ownerId)))
      .orderBy(asc(schema.ree.id))
      .for('update');
    const plan = visibilityPlan(
      rows.map((row) => ({ id: row.id, isPublic: row.isPublic, moderated: row.moderatedAt !== null })),
      ids,
      isPublic,
    );
    if (plan.changes.length) {
      await tx
        .update(schema.ree)
        .set({ isPublic: sql`(${isPublic} and "ree"."moderated_at" is null)`, updatedAt: new Date() })
        .where(inArray(schema.ree.id, plan.changes));
      if (!isPublic) for (const id of plan.changes) await hide(tx, id, { includeOwner: false });
    }
    return plan;
  });
}

async function hide(tx: Tx, reeId: string, options: { includeOwner: boolean }): Promise<void> {
  await detachRee(tx, reeId, options);
  await tx.delete(schema.reeProfileVector).where(eq(schema.reeProfileVector.reeId, reeId));
}

/** Soft: the row stays so past conversations still show the name (8.2, "Ree 删除"). */
export async function deleteRee(ownerId: string, id: string): Promise<boolean> {
  return db().transaction(async (tx) => {
    const rows = await tx
      .update(schema.ree)
      .set({ deletedAt: new Date(), isPublic: false })
      .where(and(eq(schema.ree.id, id), ownedLive(ownerId)))
      .returning({ id: schema.ree.id });
    if (rows.length) await hide(tx, id, { includeOwner: true });
    return rows.length > 0;
  });
}
