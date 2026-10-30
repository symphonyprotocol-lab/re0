/**
 * Comments on channel assets. agent-first-proposal.md 6.8, 10.
 *
 * Who may read and write is `lib/domain/comment.ts`'s; this applies it to
 * rows. A comment is never an asset: nothing here touches a version, a
 * chunk or an anchor, and no retrieval path reads this table -- comments
 * are the readers' words, not the creator's, and may carry their personal
 * details. What a creator wants answered goes through the pending-questions
 * list instead (`moveCommentToQuestions`), and the Q&A asset that comes of
 * it cites only the creator's own answer.
 *
 * Safety: bodies are stored as plain text and rendered as such (links get
 * `nofollow ugc` and an external-link hint, `lib/domain/comment.ts`
 * `commentPieces`); writing is rate-limited per author; each body runs the
 * same scan uploaded content does (requirement.md 12 item 3) and a hit is
 * hidden at once for the creator to look at. Readers report, the creator
 * pins, hides, deletes and closes, the platform takes down.
 */
import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import {
  COMMENT_LIMITS,
  CommentRefused,
  DELETED_COMMENT_PLACEHOLDER,
  mayReadComments,
  mayWriteComment,
  normalizeCommentBody,
  type CommentContext,
  type CommentState,
} from '@/lib/domain/comment';
import { normalizeReason } from '@/lib/domain/admin';
import { uuidv7 } from '@/lib/domain/id';
import { safetyFindingsOf, scanContent } from '@/lib/domain/ingestion';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { recordAudit } from '@/lib/application/administration/audit';
import { canManageAssets, type WorkspaceRole } from '@/lib/application/assets/delete';
import { subscribesTo } from '@/lib/application/channels/subscriptions';
import { notify, workspaceManagers } from '@/lib/application/notifications';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CommentViewerInput {
  userId: string | null;
  /** The viewer's personal workspace: ownership and subscription are read through it. */
  workspaceId: string | null;
  role?: WorkspaceRole;
}

interface AssetFacts {
  assetId: string;
  publicId: string;
  title: string;
  ownerWorkspaceId: string | null;
  channelId: string | null;
  context: CommentContext;
}

async function assetFacts(assetId: string): Promise<AssetFacts | null> {
  if (!UUID.test(assetId)) return null;
  const [row] = await db()
    .select({
      assetId: schema.asset.id,
      publicId: schema.asset.publicId,
      title: schema.asset.title,
      ownerWorkspaceId: schema.asset.ownerWorkspaceId,
      access: schema.asset.access,
      channelId: schema.channel.id,
      visibility: schema.channel.visibility,
      status: schema.channel.status,
      commentsClosed: schema.channelAsset.commentsClosed,
    })
    .from(schema.asset)
    .leftJoin(schema.channelAsset, eq(schema.channelAsset.assetId, schema.asset.id))
    .leftJoin(schema.channel, eq(schema.channel.id, schema.channelAsset.channelId))
    .where(and(eq(schema.asset.id, assetId), isNull(schema.asset.deletedAt)));
  if (!row) return null;
  return {
    assetId: row.assetId,
    publicId: row.publicId,
    title: row.title,
    ownerWorkspaceId: row.ownerWorkspaceId,
    channelId: row.channelId,
    context: {
      channel: row.channelId && row.visibility && row.status ? { visibility: row.visibility, status: row.status } : null,
      access: row.access,
      commentsClosed: row.commentsClosed ?? false,
    },
  };
}

async function viewerFlags(facts: AssetFacts, viewer: CommentViewerInput) {
  const isOwner = viewer.workspaceId !== null && facts.ownerWorkspaceId === viewer.workspaceId;
  const isSubscriber =
    !isOwner && facts.channelId && facts.context.access === 'paid' ? await subscribesTo(viewer.workspaceId, facts.channelId) : false;
  return { signedIn: viewer.userId !== null, isOwner, isSubscriber };
}

/* ------------------------------------------------------------------- read */

export interface CommentView {
  id: string;
  parentId: string | null;
  authorName: string;
  /** True for the viewer's own comment, which they may delete. */
  mine: boolean;
  /** Written by the asset's creator. */
  byCreator: boolean;
  body: string;
  state: CommentState;
  hiddenReason: 'creator' | 'scan' | null;
  pinned: boolean;
  createdAt: Date;
  replies: CommentView[];
}

export interface CommentThread {
  /** Whether the asset has a comment section at all, for this viewer. */
  visible: boolean;
  mayWrite: boolean;
  closed: boolean;
  viewerIsCreator: boolean;
  comments: CommentView[];
}

const NO_THREAD: CommentThread = { visible: false, mayWrite: false, closed: false, viewerIsCreator: false, comments: [] };

/**
 * The asset's comments as this viewer may see them: none at all when the
 * section is closed to them; for readers, visible comments only, with a
 * placeholder where a deleted one still has replies; for the creator, the
 * hidden ones too, marked.
 */
export async function listComments(assetId: string, viewer: CommentViewerInput): Promise<CommentThread> {
  const facts = await assetFacts(assetId);
  if (!facts) return NO_THREAD;
  const flags = await viewerFlags(facts, viewer);
  if (!mayReadComments(facts.context, flags)) return NO_THREAD;

  const rows = await db()
    .select({
      id: schema.comment.id,
      parentId: schema.comment.parentId,
      authorUserId: schema.comment.authorUserId,
      displayName: schema.user.displayName,
      body: schema.comment.body,
      state: schema.comment.state,
      hiddenReason: schema.comment.hiddenReason,
      pinnedAt: schema.comment.pinnedAt,
      createdAt: schema.comment.createdAt,
    })
    .from(schema.comment)
    .leftJoin(schema.user, eq(schema.user.id, schema.comment.authorUserId))
    .where(eq(schema.comment.assetId, facts.assetId))
    .orderBy(asc(schema.comment.createdAt))
    .limit(500);

  const creators = new Set(facts.ownerWorkspaceId ? await workspaceManagers(facts.ownerWorkspaceId) : []);
  const views = new Map<string, CommentView>();
  for (const row of rows) {
    const gone = row.state === 'deleted' || row.state === 'removed';
    if (row.state === 'hidden' && !flags.isOwner) continue;
    views.set(row.id, {
      id: row.id,
      parentId: row.parentId,
      authorName: gone ? '' : row.displayName?.trim() || 'Reader',
      mine: viewer.userId !== null && row.authorUserId === viewer.userId && !gone,
      byCreator: row.authorUserId !== null && creators.has(row.authorUserId),
      body: gone ? DELETED_COMMENT_PLACEHOLDER : row.body,
      state: row.state,
      hiddenReason: row.hiddenReason ?? null,
      pinned: row.pinnedAt !== null,
      createdAt: row.createdAt,
      replies: [],
    });
  }
  const top: CommentView[] = [];
  for (const view of views.values()) {
    if (view.parentId) views.get(view.parentId)?.replies.push(view);
    else top.push(view);
  }
  /* A deleted comment with nothing under it leaves no trace; one with replies keeps its place. */
  const shown = top
    .filter((view) => !((view.state === 'deleted' || view.state === 'removed') && view.replies.length === 0))
    .map((view) => ({ ...view, replies: view.replies.filter((reply) => reply.state !== 'deleted' && reply.state !== 'removed') }));
  shown.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.createdAt.getTime() - b.createdAt.getTime());
  return {
    visible: true,
    mayWrite: mayWriteComment(facts.context, flags),
    closed: facts.context.commentsClosed,
    viewerIsCreator: flags.isOwner,
    comments: shown,
  };
}

/* ------------------------------------------------------------------ write */

export async function postComment(input: CommentViewerInput & { assetId: string; body: unknown; parentId?: string | null }): Promise<{ commentId: string; hidden: boolean }> {
  if (!input.userId) throw new CommentRefused('not_allowed', 'sign in to comment');
  const userId = input.userId;
  const facts = await assetFacts(input.assetId);
  if (!facts) throw new CommentRefused('not_found', 'no such asset');
  const flags = await viewerFlags(facts, input);
  if (!mayWriteComment(facts.context, flags)) throw new CommentRefused('not_allowed', 'comments are not open to you here');
  const body = normalizeCommentBody(input.body);

  const database = db();
  let parentAuthor: string | null = null;
  if (input.parentId) {
    if (!UUID.test(input.parentId)) throw new CommentRefused('not_found', 'no such comment');
    const [parent] = await database
      .select({ id: schema.comment.id, assetId: schema.comment.assetId, parentId: schema.comment.parentId, state: schema.comment.state, authorUserId: schema.comment.authorUserId })
      .from(schema.comment)
      .where(eq(schema.comment.id, input.parentId));
    if (!parent || parent.assetId !== facts.assetId || parent.state !== 'visible') throw new CommentRefused('not_found', 'no such comment');
    /* One level of replies (proposal 6.8). */
    if (parent.parentId) throw new CommentRefused('reply_depth', 'replies go under the comment, one level deep');
    parentAuthor = parent.authorUserId;
  }

  const findings = safetyFindingsOf(scanContent(body));
  const hidden = findings.length > 0;
  const commentId = uuidv7();
  await database.transaction(async (tx) => {
    /* Serialises one author's writes so the count below is a real limit, not a race. */
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`comment:${userId}`}))`);
    const now = Date.now();
    const [recent] = await tx
      .select({
        minute: sql<number>`(count(*) filter (where ${schema.comment.createdAt} >= ${new Date(now - COMMENT_LIMITS.rateWindowSeconds * 1000)}))::int`,
        day: sql<number>`count(*)::int`,
      })
      .from(schema.comment)
      .where(and(eq(schema.comment.authorUserId, userId), gte(schema.comment.createdAt, new Date(now - 86_400_000))));
    if ((recent?.minute ?? 0) >= COMMENT_LIMITS.rateCount || (recent?.day ?? 0) >= COMMENT_LIMITS.dailyCount) {
      throw new CommentRefused('rate_limited', 'too many comments; try again in a minute');
    }
    await tx.insert(schema.comment).values({
      id: commentId,
      assetId: facts.assetId,
      authorUserId: userId,
      parentId: input.parentId ?? null,
      body,
      state: hidden ? 'hidden' : 'visible',
      hiddenReason: hidden ? 'scan' : null,
      findings,
    });
    const payload = { assetId: facts.assetId, publicId: facts.publicId, title: facts.title, commentId, held: hidden };
    if (facts.ownerWorkspaceId && !flags.isOwner) {
      await notify(await workspaceManagers(facts.ownerWorkspaceId, tx), 'new_comment', payload, tx);
    }
    if (parentAuthor && parentAuthor !== userId && !hidden) await notify([parentAuthor], 'comment_reply', payload, tx);
  });
  return { commentId, hidden };
}

/** The author removes their own comment; its text is blanked, its place kept for any replies. */
export async function deleteOwnComment(input: { userId: string; commentId: string }): Promise<void> {
  if (!UUID.test(input.commentId)) throw new CommentRefused('not_found', 'no such comment');
  const updated = await db()
    .update(schema.comment)
    .set({ state: 'deleted', body: DELETED_COMMENT_PLACEHOLDER, findings: [], pinnedAt: null, updatedAt: new Date() })
    .where(and(eq(schema.comment.id, input.commentId), eq(schema.comment.authorUserId, input.userId)))
    .returning({ id: schema.comment.id });
  if (updated.length === 0) throw new CommentRefused('not_author', 'only its author can delete a comment this way');
}

/** Account deletion (proposal 6.8): every comment's body goes, a placeholder stays. */
export async function eraseUserComments(userId: string): Promise<number> {
  const updated = await db()
    .update(schema.comment)
    .set({ state: 'deleted', body: DELETED_COMMENT_PLACEHOLDER, findings: [], pinnedAt: null, updatedAt: new Date() })
    .where(eq(schema.comment.authorUserId, userId))
    .returning({ id: schema.comment.id });
  return updated.length;
}

export async function reportComment(input: CommentViewerInput & { commentId: string; reason: string }): Promise<void> {
  if (!input.userId) throw new CommentRefused('not_allowed', 'sign in to report');
  if (!UUID.test(input.commentId)) throw new CommentRefused('not_found', 'no such comment');
  const reason = input.reason.trim().slice(0, COMMENT_LIMITS.reportReasonMax) || 'unspecified';
  const [row] = await db()
    .select({ assetId: schema.comment.assetId, state: schema.comment.state })
    .from(schema.comment)
    .where(eq(schema.comment.id, input.commentId));
  if (!row || row.state !== 'visible') throw new CommentRefused('not_found', 'no such comment');
  /* Only someone who can read it can report it. */
  const facts = await assetFacts(row.assetId);
  if (!facts || !mayReadComments(facts.context, await viewerFlags(facts, input))) {
    throw new CommentRefused('not_found', 'no such comment');
  }
  const inserted = await db()
    .insert(schema.commentReport)
    .values({ id: uuidv7(), commentId: input.commentId, reporterUserId: input.userId, reason })
    .onConflictDoNothing()
    .returning({ id: schema.commentReport.id });
  if (inserted.length === 0) throw new CommentRefused('already_reported', 'you have reported this comment already');
}

/* -------------------------------------------------------------- moderation */

interface CreatorInput {
  workspaceId: string;
  role: WorkspaceRole;
  commentId: string;
}

async function creatorComment(input: CreatorInput) {
  if (!canManageAssets(input.role)) throw new CommentRefused('not_owner', 'only the creator moderates comments');
  if (!UUID.test(input.commentId)) throw new CommentRefused('not_found', 'no such comment');
  const [row] = await db()
    .select({
      id: schema.comment.id,
      assetId: schema.comment.assetId,
      parentId: schema.comment.parentId,
      body: schema.comment.body,
      state: schema.comment.state,
      authorUserId: schema.comment.authorUserId,
      channelId: schema.channelAsset.channelId,
    })
    .from(schema.comment)
    .innerJoin(schema.asset, eq(schema.asset.id, schema.comment.assetId))
    .leftJoin(schema.channelAsset, eq(schema.channelAsset.assetId, schema.asset.id))
    .where(and(eq(schema.comment.id, input.commentId), eq(schema.asset.ownerWorkspaceId, input.workspaceId)));
  if (!row) throw new CommentRefused('not_found', 'no such comment');
  return row;
}

export type CreatorModeration = 'pin' | 'unpin' | 'hide' | 'unhide' | 'delete';

export async function moderateComment(input: CreatorInput & { action: CreatorModeration }): Promise<void> {
  const row = await creatorComment(input);
  /* The platform's takedown is final; the creator cannot undo it. */
  if (row.state === 'removed' || (row.state === 'deleted' && input.action !== 'delete')) {
    throw new CommentRefused('not_found', 'this comment is gone');
  }
  const now = new Date();
  const set =
    input.action === 'pin'
      ? row.parentId
        ? null
        : { pinnedAt: now }
      : input.action === 'unpin'
        ? { pinnedAt: null }
        : input.action === 'hide'
          ? { state: 'hidden' as const, hiddenReason: 'creator' as const, pinnedAt: null }
          : input.action === 'unhide'
            ? { state: 'visible' as const, hiddenReason: null }
            : { state: 'deleted' as const, pinnedAt: null };
  if (!set) throw new CommentRefused('reply_depth', 'only a top-level comment can be pinned');
  await db().update(schema.comment).set({ ...set, updatedAt: now }).where(eq(schema.comment.id, row.id));
}

/** The creator closes or reopens comments on one asset; what is there stays. */
export async function setCommentsClosed(input: { workspaceId: string; role: WorkspaceRole; assetId: string; closed: boolean }): Promise<void> {
  if (!canManageAssets(input.role)) throw new CommentRefused('not_owner', 'only the creator closes comments');
  if (!UUID.test(input.assetId)) throw new CommentRefused('not_found', 'no such asset');
  const updated = await db()
    .update(schema.channelAsset)
    .set({ commentsClosed: input.closed })
    .where(
      and(
        eq(schema.channelAsset.assetId, input.assetId),
        sql`exists (select 1 from ${schema.asset} l where l.id = ${schema.channelAsset.assetId} and l.owner_workspace_id = ${input.workspaceId})`,
      ),
    )
    .returning({ assetId: schema.channelAsset.assetId });
  if (updated.length === 0) throw new CommentRefused('not_found', 'the asset is in none of your channels');
}

/**
 * Moves a good question from the comments into the pending-questions list
 * (proposal 6.8). The comment itself is untouched; the answer, when it comes,
 * cites only the creator's own words.
 */
export async function moveCommentToQuestions(input: CreatorInput): Promise<{ questionId: string }> {
  const row = await creatorComment(input);
  if (!row.channelId || row.state !== 'visible') throw new CommentRefused('not_found', 'no such comment');
  const questionId = uuidv7();
  await db().insert(schema.channelQuestion).values({
    id: questionId,
    channelId: row.channelId,
    askerUserId: row.authorUserId,
    question: row.body.slice(0, 2_000),
    source: 'comment',
    commentId: row.id,
  });
  return { questionId };
}

/** The creator's moderation queue: every comment on their assets, newest first, hidden ones flagged. */
export async function workspaceComments(workspaceId: string, limit = 100) {
  return db()
    .select({
      id: schema.comment.id,
      assetId: schema.comment.assetId,
      assetTitle: schema.asset.title,
      publicId: schema.asset.publicId,
      parentId: schema.comment.parentId,
      authorName: schema.user.displayName,
      body: schema.comment.body,
      state: schema.comment.state,
      hiddenReason: schema.comment.hiddenReason,
      findings: schema.comment.findings,
      pinnedAt: schema.comment.pinnedAt,
      createdAt: schema.comment.createdAt,
      reports: sql<number>`(select count(*)::int from ${schema.commentReport} r where r.comment_id = ${schema.comment.id} and r.resolved_at is null)`,
      commentsClosed: schema.channelAsset.commentsClosed,
    })
    .from(schema.comment)
    .innerJoin(schema.asset, eq(schema.asset.id, schema.comment.assetId))
    .leftJoin(schema.channelAsset, eq(schema.channelAsset.assetId, schema.asset.id))
    .leftJoin(schema.user, eq(schema.user.id, schema.comment.authorUserId))
    .where(and(eq(schema.asset.ownerWorkspaceId, workspaceId), inArray(schema.comment.state, ['visible', 'hidden'])))
    .orderBy(sql`${schema.comment.createdAt} desc`)
    .limit(limit);
}

/* --------------------------------------------------------------- platform */

export async function openCommentReports(limit = 100) {
  return db()
    .select({
      reportId: schema.commentReport.id,
      reason: schema.commentReport.reason,
      reportedAt: schema.commentReport.createdAt,
      commentId: schema.comment.id,
      body: schema.comment.body,
      state: schema.comment.state,
      assetTitle: schema.asset.title,
      publicId: schema.asset.publicId,
    })
    .from(schema.commentReport)
    .innerJoin(schema.comment, eq(schema.comment.id, schema.commentReport.commentId))
    .innerJoin(schema.asset, eq(schema.asset.id, schema.comment.assetId))
    .where(isNull(schema.commentReport.resolvedAt))
    .orderBy(asc(schema.commentReport.createdAt))
    .limit(limit);
}

/**
 * The platform's ruling on a reported comment: `remove` takes it down for
 * good, `dismiss` leaves it. Either resolves every open report on it, and the
 * ruling is audited (requirement.md 5.3).
 */
export async function resolveCommentReport(input: {
  actor: { administratorId: string; clientAddress?: string | null };
  commentId: string;
  ruling: 'remove' | 'dismiss';
  reason: string;
}): Promise<void> {
  const reason = normalizeReason(input.reason);
  if (!UUID.test(input.commentId)) throw new CommentRefused('not_found', 'no such comment');
  const now = new Date();
  const before = await db().transaction(async (tx) => {
    const [row] = await tx.select({ state: schema.comment.state }).from(schema.comment).where(eq(schema.comment.id, input.commentId)).for('update');
    if (!row) throw new CommentRefused('not_found', 'no such comment');
    if (input.ruling === 'remove') {
      await tx.update(schema.comment).set({ state: 'removed', pinnedAt: null, updatedAt: now }).where(eq(schema.comment.id, input.commentId));
    }
    await tx
      .update(schema.commentReport)
      .set({ resolvedAt: now, resolution: input.ruling })
      .where(and(eq(schema.commentReport.commentId, input.commentId), isNull(schema.commentReport.resolvedAt)));
    return row.state;
  });
  await recordAudit({
    administratorId: input.actor.administratorId,
    action: input.ruling === 'remove' ? 'comment.remove' : 'comment.report_dismiss',
    targetType: 'comment',
    targetId: input.commentId,
    reason,
    beforeValue: { state: before },
    afterValue: { state: input.ruling === 'remove' ? 'removed' : before },
    clientAddress: input.actor.clientAddress,
    result: 'success',
  });
}
