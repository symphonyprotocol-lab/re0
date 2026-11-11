/**
 * Conversations with one to five Rees (rebuild-proposal.md 5, 8.2 "对话列表"):
 * creating one, its participants, the `/chats` search page, organising
 * (rename, pin, archive, trash, restore, in batches), the sidebar's history,
 * the 30-day trash purge, and taking a Ree out of other people's
 * conversations when it stops being public.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { CONVERSATION_BATCH_MAX, CONVERSATION_MAX_REES, CONVERSATION_TRASH_DAYS, PICKER_RESULTS, QUERY_BASE_FEE, SIDEBAR_HISTORY_MAX } from '@/lib/constants';
import { cleanTitle, participantSet, type BatchAction, type ConversationQuery, type ConversationView } from '@/lib/domain/conversation';
import { clampPage, likePattern, type ListResult, isUuid } from '@/lib/domain/list';
import { db, schema, type Executor } from '@/lib/infra/db';

export type ConversationRow = typeof schema.conversation.$inferSelect;

export class ConversationError extends Error {
  constructor(
    readonly code: 'not_found' | 'ree_unavailable' | 'too_many_rees' | 'invalid_title' | 'invalid_action' | 'too_many',
    readonly status = 422,
  ) {
    super(code);
    this.name = 'ConversationError';
  }
}

/** A Ree this user may put in a conversation: their own, or public and not taken down; never a deleted one (3). */
export function usableBy(userId: string): SQL {
  return and(
    isNull(schema.ree.deletedAt),
    or(eq(schema.ree.ownerId, userId), and(eq(schema.ree.isPublic, true), eq(schema.ree.isPublished, true), isNull(schema.ree.moderatedAt))),
  )!;
}

/** What a page needs to show a Ree in a conversation, its owner's role included (2.7). */
export interface ReeBrief {
  id: string;
  slug: string;
  name: string;
  description: string;
  avatarBlob: string | null;
  color: string;
  ownerId: string;
  ownerName: string;
  role: 'normal' | 'verified' | 'official';
  queryFee: number;
  isPublic: boolean;
  sampleQuestions: string[];
  /** Still public (or the viewer's own) and not deleted: it can be asked. */
  usable: boolean;
}

/** The fee one answer costs this asker (2.3): the base fee, plus the query fee on someone else's Ree. */
export function priceFor(ree: { ownerId: string; queryFee: number }, userId: string | null): number {
  return QUERY_BASE_FEE + (ree.ownerId === userId ? 0 : ree.queryFee);
}

const briefColumns = (viewerId: string) => ({
  id: schema.ree.id,
  slug: schema.ree.slug,
  name: schema.ree.name,
  description: schema.ree.description,
  avatarBlob: schema.ree.avatarBlob,
  color: schema.ree.color,
  ownerId: schema.ree.ownerId,
  ownerName: schema.user.name,
  role: schema.user.role,
  queryFee: schema.ree.queryFee,
  isPublic: sql<boolean>`(${schema.ree.isPublic} and ${schema.ree.isPublished})`,
  sampleQuestions: schema.ree.sampleQuestions,
  usable: sql<boolean>`(${usableBy(viewerId)})`,
});

/** Rees by id as this viewer sees them, deleted and private ones included (history still shows their names). */
export async function reeBriefs(executor: Executor, viewerId: string, ids: readonly string[]): Promise<Map<string, ReeBrief>> {
  if (ids.length === 0) return new Map();
  const rows = await executor
    .select(briefColumns(viewerId))
    .from(schema.ree)
    .innerJoin(schema.user, eq(schema.user.id, schema.ree.ownerId))
    .where(inArray(schema.ree.id, [...new Set(ids)]));
  return new Map(rows.map((row) => [row.id, row]));
}

/** The user's own conversation, live (not in the trash) and of the multi-Ree kind. */
export async function liveConversation(userId: string, id: string, options: { trashed?: boolean } = {}): Promise<ConversationRow | null> {
  if (!isUuid(id)) return null;
  const [row] = await db()
    .select()
    .from(schema.conversation)
    .where(
      and(
        eq(schema.conversation.id, id),
        eq(schema.conversation.userId, userId),
        eq(schema.conversation.kind, 'normal'),
        options.trashed ? undefined : isNull(schema.conversation.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Current participants, in the order they joined. */
export async function participantsOf(executor: Executor, conversationId: string, viewerId: string): Promise<ReeBrief[]> {
  const rows = await executor
    .select(briefColumns(viewerId))
    .from(schema.conversationRee)
    .innerJoin(schema.ree, eq(schema.ree.id, schema.conversationRee.reeId))
    .innerJoin(schema.user, eq(schema.user.id, schema.ree.ownerId))
    .where(eq(schema.conversationRee.conversationId, conversationId))
    .orderBy(asc(schema.conversationRee.addedAt), asc(schema.ree.name));
  return rows;
}

async function assertUsable(executor: Executor, userId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  if (!ids.every((id) => isUuid(id))) throw new ConversationError('ree_unavailable');
  const rows = await executor
    .select({ id: schema.ree.id })
    .from(schema.ree)
    .where(and(inArray(schema.ree.id, [...ids]), usableBy(userId)));
  if (rows.length !== new Set(ids).size) throw new ConversationError('ree_unavailable');
}

/** `POST /api/chats`: a new conversation, optionally with its first Rees (0–5). */
export async function createConversation(userId: string, input: { reeIds?: unknown; title?: unknown }): Promise<ConversationRow> {
  const ids = participantSet(Array.isArray(input.reeIds) ? input.reeIds.map(String) : []);
  if (!ids) throw new ConversationError('too_many_rees', 409);
  const title = input.title === undefined || input.title === '' ? '' : cleanTitle(input.title);
  if (title === null) throw new ConversationError('invalid_title');
  return db().transaction(async (tx) => {
    await assertUsable(tx, userId, ids);
    const [row] = await tx.insert(schema.conversation).values({ userId, kind: 'normal', title }).returning();
    if (ids.length) await tx.insert(schema.conversationRee).values(ids.map((reeId, at) => ({ conversationId: row!.id, reeId, addedAt: new Date(Date.now() + at) })));
    return row!;
  });
}

/**
 * Pulls a Ree in (3, "只能拉自己的或公开的"); the sixth is refused. The
 * conversation row is locked so two tabs adding at once cannot make six.
 */
export async function addParticipant(userId: string, conversationId: string, reeId: string): Promise<'added' | 'present'> {
  return db().transaction(async (tx) => {
    const [conversation] = await tx
      .select({ id: schema.conversation.id })
      .from(schema.conversation)
      .where(and(eq(schema.conversation.id, conversationId), eq(schema.conversation.userId, userId), eq(schema.conversation.kind, 'normal'), isNull(schema.conversation.deletedAt)))
      .for('update');
    if (!conversation) throw new ConversationError('not_found', 404);
    await assertUsable(tx, userId, [reeId]);
    const members = await tx.select({ reeId: schema.conversationRee.reeId }).from(schema.conversationRee).where(eq(schema.conversationRee.conversationId, conversationId));
    if (members.some((row) => row.reeId === reeId)) return 'present';
    if (members.length >= CONVERSATION_MAX_REES) throw new ConversationError('too_many_rees', 409);
    await tx.insert(schema.conversationRee).values({ conversationId, reeId });
    return 'added';
  });
}

/**
 * The participant picker's "完成": the whole new set in one transaction, so
 * a refused Ree (private now, or a sixth) changes nothing at all. Rees
 * staying in keep their place; past answers stay either way.
 */
export async function setParticipants(userId: string, conversationId: string, reeIds: unknown): Promise<string[]> {
  const ids = participantSet(Array.isArray(reeIds) ? reeIds.map(String) : []);
  if (!ids) throw new ConversationError('too_many_rees', 409);
  return db().transaction(async (tx) => {
    const [conversation] = await tx
      .select({ id: schema.conversation.id })
      .from(schema.conversation)
      .where(and(eq(schema.conversation.id, conversationId), eq(schema.conversation.userId, userId), eq(schema.conversation.kind, 'normal'), isNull(schema.conversation.deletedAt)))
      .for('update');
    if (!conversation) throw new ConversationError('not_found', 404);
    const current = (await tx.select({ reeId: schema.conversationRee.reeId }).from(schema.conversationRee).where(eq(schema.conversationRee.conversationId, conversationId))).map((row) => row.reeId);
    const added = ids.filter((id) => !current.includes(id));
    await assertUsable(tx, userId, added);
    const removed = current.filter((id) => !ids.includes(id));
    if (removed.length) await tx.delete(schema.conversationRee).where(and(eq(schema.conversationRee.conversationId, conversationId), inArray(schema.conversationRee.reeId, removed)));
    const now = Date.now();
    if (added.length) await tx.insert(schema.conversationRee).values(added.map((reeId, at) => ({ conversationId, reeId, addedAt: new Date(now + at) })));
    return ids;
  });
}

/** Takes a Ree out; its past answers stay in the conversation. */
export async function removeParticipant(userId: string, conversationId: string, reeId: string): Promise<boolean> {
  const conversation = await liveConversation(userId, conversationId);
  if (!conversation) throw new ConversationError('not_found', 404);
  if (!isUuid(reeId)) return false;
  const rows = await db()
    .delete(schema.conversationRee)
    .where(and(eq(schema.conversationRee.conversationId, conversationId), eq(schema.conversationRee.reeId, reeId)))
    .returning({ reeId: schema.conversationRee.reeId });
  return rows.length > 0;
}

/**
 * A Ree turned private, was taken down or deleted: out of every conversation
 * of anyone but its owner (all of them, when deleted). Messages stay, and
 * still show its name (8.2, "Ree 删除"). Step 5's takedown calls this too.
 */
export async function detachRee(executor: Executor, reeId: string, options: { includeOwner: boolean }): Promise<number> {
  const rows = await executor
    .delete(schema.conversationRee)
    .where(
      and(
        eq(schema.conversationRee.reeId, reeId),
        options.includeOwner
          ? undefined
          : sql`${schema.conversationRee.conversationId} in (select c.id from ${schema.conversation} c join ${schema.ree} r on r.id = ${reeId} where c.user_id <> r.owner_id)`,
      ),
    )
    .returning({ conversationId: schema.conversationRee.conversationId });
  return rows.length;
}

/* -------------------------------------------------------------- organise */

/** Rename, pin, archive, trash or restore one conversation (`PATCH /api/chats/[id]`). */
export async function updateConversation(
  userId: string,
  id: string,
  patch: { title?: unknown; pinned?: unknown; archived?: unknown; trashed?: unknown },
): Promise<ConversationRow> {
  const current = await liveConversation(userId, id, { trashed: true });
  if (!current) throw new ConversationError('not_found', 404);
  if (patch.title !== undefined) {
    const title = cleanTitle(patch.title);
    if (!title) throw new ConversationError('invalid_title');
    const [row] = await db().update(schema.conversation).set({ title }).where(eq(schema.conversation.id, id)).returning();
    current.title = row!.title;
  }
  if (typeof patch.pinned === 'boolean') await runBatch(userId, patch.pinned ? 'pin' : 'unpin', [id]);
  if (typeof patch.archived === 'boolean') await runBatch(userId, patch.archived ? 'archive' : 'unarchive', [id]);
  if (typeof patch.trashed === 'boolean') await runBatch(userId, patch.trashed ? 'trash' : 'restore', [id]);
  return (await liveConversation(userId, id, { trashed: true }))!;
}

/**
 * The batch actions (prototype conversations.js): pin only what is not
 * archived; archiving unpins; trash and restore move whole conversations,
 * messages and participants kept. Delete permanently removes only the
 * caller's trashed conversations, cascading to messages and participants.
 * Answers how many rows changed.
 */
export async function runBatch(userId: string, action: BatchAction, ids: readonly string[], now = new Date()): Promise<number> {
  const unique = [...new Set(ids)].filter((id) => isUuid(id));
  if (unique.length === 0) return 0;
  if (unique.length > CONVERSATION_BATCH_MAX) throw new ConversationError('too_many');
  const mine = and(eq(schema.conversation.userId, userId), eq(schema.conversation.kind, 'normal'), inArray(schema.conversation.id, unique));
  if (action === 'delete') {
    const rows = await db()
      .delete(schema.conversation)
      .where(and(mine, isNotNull(schema.conversation.deletedAt)))
      .returning({ id: schema.conversation.id });
    return rows.length;
  }
  const live = and(mine, isNull(schema.conversation.deletedAt));
  const change = {
    pin: { set: { pinned: true }, where: and(live, isNull(schema.conversation.archivedAt)) },
    unpin: { set: { pinned: false }, where: live },
    archive: { set: { archivedAt: now, pinned: false }, where: and(live, isNull(schema.conversation.archivedAt)) },
    unarchive: { set: { archivedAt: null }, where: and(live, isNotNull(schema.conversation.archivedAt)) },
    trash: { set: { deletedAt: now }, where: live },
    restore: { set: { deletedAt: null }, where: and(mine, isNotNull(schema.conversation.deletedAt)) },
  }[action];
  if (!change) throw new ConversationError('invalid_action');
  const rows = await db().update(schema.conversation).set(change.set).where(change.where).returning({ id: schema.conversation.id });
  return rows.length;
}

/** Trashed conversations older than 30 days, with their messages (cascade), in bounded batches. Idempotent. */
export async function purgeConversationTrash(now = new Date(), limit = 500): Promise<number> {
  const cutoff = new Date(now.getTime() - CONVERSATION_TRASH_DAYS * 86_400_000);
  const rows = await db()
    .delete(schema.conversation)
    .where(
      inArray(
        schema.conversation.id,
        db()
          .select({ id: schema.conversation.id })
          .from(schema.conversation)
          .where(and(isNotNull(schema.conversation.deletedAt), lt(schema.conversation.deletedAt, cutoff)))
          .limit(limit),
      ),
    )
    .returning({ id: schema.conversation.id });
  return rows.length;
}

/* ------------------------------------------------------------ search page */

const conversationId = sql.raw('"conversation"."id"');

function viewCondition(view: ConversationView): SQL | undefined {
  switch (view) {
    case 'trash':
      return isNotNull(schema.conversation.deletedAt);
    case 'recent':
      return and(isNull(schema.conversation.deletedAt), isNull(schema.conversation.archivedAt));
    case 'pinned':
      return and(isNull(schema.conversation.deletedAt), isNull(schema.conversation.archivedAt), eq(schema.conversation.pinned, true));
    case 'archived':
      return and(isNull(schema.conversation.deletedAt), isNotNull(schema.conversation.archivedAt));
    case 'all':
      return isNull(schema.conversation.deletedAt);
  }
}

/**
 * The search and filters, without the tab: title, any message's text, or
 * the name of a Ree in it (participant now, or one that answered before);
 * one Ree; updated (or, in the trash, trashed) within N days.
 */
function filterConditions(userId: string, query: Pick<ConversationQuery, 'q' | 'ree' | 'days'>, trash: boolean, now: Date): SQL[] {
  const conditions: SQL[] = [eq(schema.conversation.userId, userId), eq(schema.conversation.kind, 'normal')];
  const reesOf = sql`(select cr.ree_id from ${schema.conversationRee} cr where cr.conversation_id = ${conversationId} union select m.ree_id from ${schema.message} m where m.conversation_id = ${conversationId} and m.ree_id is not null)`;
  if (query.q) {
    const pattern = likePattern(query.q);
    conditions.push(
      or(
        sql`${schema.conversation.title} ilike ${pattern}`,
        sql`exists (select 1 from ${schema.message} m where m.conversation_id = ${conversationId} and m.content ilike ${pattern})`,
        sql`exists (select 1 from ${schema.ree} r where r.id in ${reesOf} and r.name ilike ${pattern})`,
      )!,
    );
  }
  if (query.ree) conditions.push(sql`${query.ree}::uuid in ${reesOf}`);
  if (query.days) {
    const since = new Date(now.getTime() - query.days * 86_400_000);
    conditions.push(gte(trash ? schema.conversation.deletedAt : schema.conversation.updatedAt, since));
  }
  return conditions;
}

export interface ConversationListItem {
  id: string;
  title: string;
  pinned: boolean;
  archivedAt: Date | null;
  deletedAt: Date | null;
  updatedAt: Date;
  questions: number;
  /** The first message containing the search, when there is a search. */
  matched: string | null;
  /** The latest message with text, when there is a search: the snippet of a row matched only by its title or a Ree's name. */
  latest: string | null;
  participants: { id: string; name: string; avatarBlob: string | null; color: string }[];
}

export type ConversationCounts = Record<ConversationView, number>;

export async function listConversations(userId: string, query: ConversationQuery, now = new Date()): Promise<ListResult<ConversationListItem> & { counts: ConversationCounts }> {
  const database = db();
  const trash = query.view === 'trash';
  const where = and(...filterConditions(userId, query, trash, now), viewCondition(query.view));
  const live = and(...filterConditions(userId, query, false, now));
  const [counted] = await database
    .select({
      all: sql<number>`count(*) filter (where ${viewCondition('all')})::int`,
      recent: sql<number>`count(*) filter (where ${viewCondition('recent')})::int`,
      pinned: sql<number>`count(*) filter (where ${viewCondition('pinned')})::int`,
      archived: sql<number>`count(*) filter (where ${viewCondition('archived')})::int`,
    })
    .from(schema.conversation)
    .where(live);
  const [trashed] = await database
    .select({ trash: sql<number>`count(*)::int` })
    .from(schema.conversation)
    .where(and(...filterConditions(userId, query, true, now), viewCondition('trash')));
  const counts: ConversationCounts = { all: 0, recent: 0, pinned: 0, archived: 0, ...counted, trash: trashed?.trash ?? 0 };
  const total = counts[query.view];
  const page = clampPage(query.page, total, query.size);
  const when = trash ? schema.conversation.deletedAt : schema.conversation.updatedAt;
  const pinnedFirst = query.sort === 'new' && (query.view === 'recent' || query.view === 'pinned') ? [desc(schema.conversation.pinned)] : [];
  const order = {
    new: [...pinnedFirst, desc(when), desc(schema.conversation.createdAt)],
    old: [asc(when), asc(schema.conversation.createdAt)],
    title: [asc(sql`lower(${schema.conversation.title})`), desc(when)],
  }[query.sort];
  const pattern = query.q ? likePattern(query.q) : null;
  const rows = await database
    .select({
      id: schema.conversation.id,
      title: schema.conversation.title,
      pinned: schema.conversation.pinned,
      archivedAt: schema.conversation.archivedAt,
      deletedAt: schema.conversation.deletedAt,
      updatedAt: schema.conversation.updatedAt,
      questions: sql<number>`(select count(*)::int from ${schema.message} m where m.conversation_id = ${conversationId} and m.role = 'user')`,
      matched: pattern
        ? sql<string | null>`(select m.content from ${schema.message} m where m.conversation_id = ${conversationId} and m.content ilike ${pattern} order by m.created_at limit 1)`
        : sql<string | null>`null`,
      latest: pattern
        ? sql<string | null>`(select m.content from ${schema.message} m where m.conversation_id = ${conversationId} and m.content <> '' order by m.created_at desc limit 1)`
        : sql<string | null>`null`,
    })
    .from(schema.conversation)
    .where(where)
    .orderBy(...order)
    .limit(query.size)
    .offset((page - 1) * query.size);
  const members = await membersOf(rows.map((row) => row.id));
  return {
    items: rows.map((row) => ({ ...row, participants: members.get(row.id) ?? [] })),
    total,
    page,
    size: query.size,
    counts,
  };
}

/**
 * Where "选择此对话" from the sidebar lands (prototype conversations.js
 * `cl-select-one`): no search or filters, the 已归档 tab for an archived
 * conversation and 全部 otherwise, on the page of the default order that
 * holds it. Null for a conversation that is not the user's or is in the trash.
 */
export async function conversationPosition(userId: string, id: string, size: number): Promise<{ view: ConversationView; page: number } | null> {
  const row = await liveConversation(userId, id);
  if (!row) return null;
  const view: ConversationView = row.archivedAt ? 'archived' : 'all';
  const [before] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.conversation)
    .where(
      and(
        eq(schema.conversation.userId, userId),
        eq(schema.conversation.kind, 'normal'),
        viewCondition(view),
        /* Compared in SQL: the timestamps carry microseconds a JS Date would round away. */
        sql`(${schema.conversation.updatedAt}, ${schema.conversation.createdAt}) > (select c.updated_at, c.created_at from ${schema.conversation} c where c.id = ${row.id})`,
      ),
    );
  return { view, page: Math.floor((before?.n ?? 0) / size) + 1 };
}

export interface TrashPreviewMessage {
  id: string;
  role: 'user' | 'ree';
  /** The answering Ree's name; null once the Ree is gone ("已移除的 Ree"). */
  reeName: string | null;
  content: string;
}

/** The read-only preview of a conversation in the trash (prototype conversations.js `cl-preview`): its last 8 messages, oldest first. */
export async function trashedPreview(userId: string, id: string): Promise<{ id: string; title: string; messages: TrashPreviewMessage[] } | null> {
  const conversation = await liveConversation(userId, id, { trashed: true });
  if (!conversation?.deletedAt) return null;
  const rows = await db()
    .select({ id: schema.message.id, role: schema.message.role, reeName: schema.ree.name, content: schema.message.content })
    .from(schema.message)
    .leftJoin(schema.ree, eq(schema.ree.id, schema.message.reeId))
    .where(eq(schema.message.conversationId, id))
    .orderBy(desc(schema.message.createdAt), desc(schema.message.id))
    .limit(8);
  return { id: conversation.id, title: conversation.title, messages: rows.reverse() };
}

/** Every id the search and filters match in a tab, for "选择全部 N 个筛选结果". */
export async function matchingConversationIds(userId: string, query: ConversationQuery, now = new Date()): Promise<string[]> {
  const rows = await db()
    .select({ id: schema.conversation.id })
    .from(schema.conversation)
    .where(and(...filterConditions(userId, query, query.view === 'trash', now), viewCondition(query.view)))
    .limit(CONVERSATION_BATCH_MAX);
  return rows.map((row) => row.id);
}

async function membersOf(ids: readonly string[]) {
  const out = new Map<string, ConversationListItem['participants']>();
  if (ids.length === 0) return out;
  const rows = await db()
    .select({ conversationId: schema.conversationRee.conversationId, id: schema.ree.id, name: schema.ree.name, avatarBlob: schema.ree.avatarBlob, color: schema.ree.color })
    .from(schema.conversationRee)
    .innerJoin(schema.ree, eq(schema.ree.id, schema.conversationRee.reeId))
    .where(inArray(schema.conversationRee.conversationId, [...ids]))
    .orderBy(asc(schema.conversationRee.addedAt));
  for (const row of rows) out.set(row.conversationId, [...(out.get(row.conversationId) ?? []), { id: row.id, name: row.name, avatarBlob: row.avatarBlob, color: row.color }]);
  return out;
}

/** The "参与的 Ree" filter's choices: every Ree in any of the user's conversations, past answers included. */
export async function conversationReeOptions(userId: string): Promise<{ id: string; name: string }[]> {
  const rows = await db().execute<{ id: string; name: string }>(sql`
    select distinct r.id, r.name from ${schema.ree} r
    where r.id in (
      select cr.ree_id from ${schema.conversationRee} cr join ${schema.conversation} c on c.id = cr.conversation_id where c.user_id = ${userId} and c.kind = 'normal'
      union
      select m.ree_id from ${schema.message} m join ${schema.conversation} c on c.id = m.conversation_id where c.user_id = ${userId} and c.kind = 'normal' and m.ree_id is not null
    )
    order by r.name`);
  return rows.rows;
}

/* --------------------------------------------------------------- sidebar */

export interface HistoryItem {
  id: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  updatedAt: string;
}

/**
 * The sidebar (prototype conversations.js `sidebar`): pinned, then recent,
 * archived and trashed ones left out -- except the conversation open right
 * now, which shows on its own when it is not in either list.
 */
export async function sidebarHistory(userId: string): Promise<HistoryItem[]> {
  const base = and(eq(schema.conversation.userId, userId), eq(schema.conversation.kind, 'normal'), isNull(schema.conversation.deletedAt), isNull(schema.conversation.archivedAt));
  const columns = { id: schema.conversation.id, title: schema.conversation.title, pinned: schema.conversation.pinned, archivedAt: schema.conversation.archivedAt, updatedAt: schema.conversation.updatedAt };
  const [pinned, recent] = await Promise.all([
    db().select(columns).from(schema.conversation).where(and(base, eq(schema.conversation.pinned, true))).orderBy(desc(schema.conversation.updatedAt)),
    db().select(columns).from(schema.conversation).where(and(base, eq(schema.conversation.pinned, false))).orderBy(desc(schema.conversation.updatedAt)).limit(SIDEBAR_HISTORY_MAX),
  ]);
  return [...pinned, ...recent].map((row) => ({ id: row.id, title: row.title, pinned: row.pinned, archived: Boolean(row.archivedAt), updatedAt: row.updatedAt.toISOString() }));
}


/* ------------------------------------------------------- participant picker */

export interface Candidate extends ReeBrief {
  price: number;
  ready: number;
}

/**
 * Who can be pulled in (prototype chat-room.js `candidates`): the user's own
 * Rees and public ones, matching the search by name, introduction or tag;
 * own Rees first, then the most active public ones.
 */
export async function pickerCandidates(userId: string, q: string, include: readonly string[] = []): Promise<Candidate[]> {
  const pattern = q.trim() ? likePattern(q.trim().slice(0, 200)) : null;
  const ready = sql<number>`(select count(*)::int from ${schema.knowledge} k where k.ree_id = ${sql.raw('"ree"."id"')} and k.status = 'ready' and k.enabled and k.deleted_at is null)`;
  const rows = await db()
    .select({ ...briefColumns(userId), ready })
    .from(schema.ree)
    .innerJoin(schema.user, eq(schema.user.id, schema.ree.ownerId))
    .where(
      and(
        usableBy(userId),
        pattern
          ? or(sql`${schema.ree.name} ilike ${pattern}`, sql`${schema.ree.description} ilike ${pattern}`, sql`exists (select 1 from unnest(${schema.ree.tags}) tag where tag ilike ${pattern})`)
          : undefined,
      ),
    )
    .orderBy(desc(sql`${schema.ree.ownerId} = ${userId}`), desc(sql`coalesce((${schema.ree.rank} ->> 'activity30')::int, 0)`), desc(schema.ree.createdAt))
    .limit(PICKER_RESULTS);
  const found = rows.map((row) => ({ ...row, price: priceFor(row, userId) }));
  const missing = include.filter((id) => !found.some((row) => row.id === id));
  if (missing.length === 0) return found;
  /* Only Rees this user may still pull in: an id alone must not reveal someone else's private Ree. */
  const extra = [...(await reeBriefs(db(), userId, missing)).values()].filter((row) => row.usable);
  return [...extra.map((row) => ({ ...row, price: priceFor(row, userId), ready: 0 })), ...found];
}

/** The user's own normal conversations a Ree could still join (public page "加入对话"): not full, not already in. */
export async function joinableConversations(userId: string, reeId: string): Promise<{ id: string; title: string; members: number }[]> {
  const members = sql<number>`(select count(*)::int from ${schema.conversationRee} cr where cr.conversation_id = ${conversationId})`;
  const rows = await db()
    .select({ id: schema.conversation.id, title: schema.conversation.title, members })
    .from(schema.conversation)
    .where(
      and(
        eq(schema.conversation.userId, userId),
        eq(schema.conversation.kind, 'normal'),
        isNull(schema.conversation.deletedAt),
        sql`${members} < ${CONVERSATION_MAX_REES}`,
        sql`not exists (select 1 from ${schema.conversationRee} cr where cr.conversation_id = ${conversationId} and cr.ree_id = ${reeId})`,
      ),
    )
    .orderBy(desc(schema.conversation.pinned), desc(schema.conversation.updatedAt))
    .limit(20);
  return rows;
}

/* --------------------------------------------------------------- feedback */

/**
 * "有用 / 没用" (2.4): only the person who asked votes, only on an answer
 * that was given; the same vote again takes it back.
 */
export async function setFeedback(userId: string, messageId: string, vote: 'up' | 'down' | null): Promise<'up' | 'down' | null> {
  if (!isUuid(messageId)) throw new ConversationError('not_found', 404);
  const [row] = await db()
    .select({ id: schema.message.id })
    .from(schema.message)
    .innerJoin(schema.conversation, eq(schema.conversation.id, schema.message.conversationId))
    .where(and(eq(schema.message.id, messageId), eq(schema.message.role, 'ree'), eq(schema.message.noAnswer, false), eq(schema.conversation.userId, userId)))
    .limit(1);
  if (!row) throw new ConversationError('not_found', 404);
  if (vote === null) {
    await db().delete(schema.reeFeedback).where(and(eq(schema.reeFeedback.messageId, messageId), eq(schema.reeFeedback.userId, userId)));
    return null;
  }
  await db()
    .insert(schema.reeFeedback)
    .values({ messageId, userId, vote })
    .onConflictDoUpdate({ target: [schema.reeFeedback.messageId, schema.reeFeedback.userId], set: { vote, createdAt: new Date() } });
  return vote;
}
