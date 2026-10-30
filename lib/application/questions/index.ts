/**
 * The channel's AI twin, the pending-questions list, Q&A assets and the
 * creator's 作者确认. agent-first-proposal.md 6.3, 6.7, 8.2.
 *
 * - A signed-in reader asks the twin on the channel page. It answers from
 *   the channel's assets the reader may read -- free ones, plus paid ones
 *   for a subscriber -- through the shared generation chain (`askScope`):
 *   every requirement.md 5.1 rule holds, the reader's workspace pays 1
 *   Call, the generation is the platform's. The page always says it is the
 *   AI twin answering from the channel, never the creator.
 * - What the twin cannot answer -- retrieval found nothing, so no model was
 *   called (rule 2) -- lands in the creator's pending-questions list, as
 *   does a reader's direct "ask the author" and a comment the creator moved
 *   there.
 * - The creator answers in writing. Publishing the answer creates a `qa`
 *   asset in that channel, free or paid, built and versioned like any other;
 *   its indexed text is the question and the creator's answer only. The
 *   asker is anonymous unless they agreed to be named. The twin cites the
 *   Q&A from then on, because it is an asset of the channel.
 * - The creator may mark one twin answer 作者确认. The mark is bound to the
 *   version the answer stood on and keeps showing after the asset updates,
 *   naming that version.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { isAssetAccess, type AssetAccess } from '@/lib/domain/asset';
import { EDITORIAL_LIMITS, editorialPublicId, EditorialRefused, qaDocument } from '@/lib/domain/editorial';
import { uuidv7 } from '@/lib/domain/id';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { askScope, type AskResult } from '@/lib/application/agent/ask';
import { moveAsset } from '@/lib/application/channels/manage';
import { setAssetAccess } from '@/lib/application/channels/subscriptions';
import { canManageLibraries, type WorkspaceRole } from '@/lib/application/libraries/delete';
import { queueBuildUnlessPending } from '@/lib/application/libraries/queue-build';
import { assertBuildAffordable } from '@/lib/application/plans/build-quota';
import type { PlaygroundDependencies } from '@/lib/application/playground';
import { notify, workspaceManagers } from '@/lib/application/notifications';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class QuestionRefused extends Error {
  constructor(
    readonly code: 'sign_in' | 'not_found' | 'invalid_question' | 'invalid_answer' | 'not_owner' | 'already_answered',
    message: string,
  ) {
    super(message);
    this.name = 'QuestionRefused';
  }
}

function questionText(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0 || text.length > EDITORIAL_LIMITS.questionMax) {
    throw new QuestionRefused('invalid_question', `a question is 1 to ${EDITORIAL_LIMITS.questionMax} characters`);
  }
  return text;
}

async function publicChannel(channelId: string) {
  if (!UUID.test(channelId)) return null;
  const [channel] = await db()
    .select({ id: schema.channel.id, slug: schema.channel.slug, title: schema.channel.title, workspaceId: schema.channel.workspaceId })
    .from(schema.channel)
    .where(and(eq(schema.channel.id, channelId), eq(schema.channel.visibility, 'public'), eq(schema.channel.status, 'active')));
  return channel ?? null;
}

/* -------------------------------------------------------------------- twin */

export interface TwinReply extends AskResult {
  twinAnswerId: string;
  /** True when the question went to the creator's pending list. */
  queued: boolean;
}

/**
 * One reader question to the channel's twin. Needs a signed-in reader
 * (proposal 6.3); the reader's own workspace pays.
 */
export async function askTwin(
  input: { userId: string | null; workspaceId: string | null; channelId: string; question: unknown; requestId?: string },
  dependencies?: PlaygroundDependencies,
): Promise<TwinReply> {
  if (!input.userId || !input.workspaceId) throw new QuestionRefused('sign_in', 'sign in to ask the twin');
  const question = questionText(input.question);
  const channel = await publicChannel(input.channelId);
  if (!channel) throw new QuestionRefused('not_found', 'no such channel');

  const result = await askScope(
    {
      workspaceId: input.workspaceId,
      apiKeyId: null,
      requestId: input.requestId ?? `req_${crypto.randomUUID()}`,
      anonymous: false,
      entrypoint: 'web',
    },
    { scope: { kind: 'channel', channelId: channel.id }, question, twin: true },
    dependencies,
  );

  /* The versions the answer stood on, most-cited first: what an endorsement binds to. */
  const counts = new Map<string, { count: number; asset: AskResult['chunks'][number]['asset'] }>();
  const cited = new Set(result.claims.flatMap((claim) => claim.chunkIds));
  for (const chunk of result.chunks) {
    if (result.outcome === 'answer' && !cited.has(chunk.chunkId)) continue;
    const known = counts.get(chunk.asset.versionId);
    if (known) known.count += 1;
    else counts.set(chunk.asset.versionId, { count: 1, asset: chunk.asset });
  }
  const versions = [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .map(({ asset }) => ({ assetId: asset.assetId, publicId: asset.publicId, title: asset.title, versionId: asset.versionId, label: asset.version }));

  const twinAnswerId = uuidv7();
  const queued = result.outcome === 'no_context';
  await db().transaction(async (tx) => {
    await tx.insert(schema.twinAnswer).values({
      id: twinAnswerId,
      channelId: channel.id,
      askerUserId: input.userId,
      question,
      outcome: result.outcome,
      claims: result.claims,
      versions,
    });
    if (queued) {
      await tx.insert(schema.channelQuestion).values({
        id: uuidv7(),
        channelId: channel.id,
        askerUserId: input.userId,
        question,
        source: 'twin_unanswered',
        twinAnswerId,
      });
      if (channel.workspaceId) {
        await notify(await workspaceManagers(channel.workspaceId, tx), 'new_question', { channelId: channel.id, title: channel.title }, tx);
      }
    }
  });
  return { ...result, twinAnswerId, queued };
}

/** A reader asks the author directly (proposal 6.7); anonymous unless they agree to be named. */
export async function askAuthor(input: {
  userId: string | null;
  channelId: string;
  question: unknown;
  nameConsent?: boolean;
}): Promise<{ questionId: string }> {
  if (!input.userId) throw new QuestionRefused('sign_in', 'sign in to ask the author');
  const question = questionText(input.question);
  const channel = await publicChannel(input.channelId);
  if (!channel || !channel.workspaceId) throw new QuestionRefused('not_found', 'no such channel');
  const questionId = uuidv7();
  await db().transaction(async (tx) => {
    await tx.insert(schema.channelQuestion).values({
      id: questionId,
      channelId: channel.id,
      askerUserId: input.userId,
      question,
      source: 'direct',
      askerNameConsent: input.nameConsent === true,
    });
    await notify(await workspaceManagers(channel.workspaceId!, tx), 'new_question', { channelId: channel.id, title: channel.title }, tx);
  });
  return { questionId };
}

/* ---------------------------------------------------------- creator's list */

export interface PendingQuestion {
  id: string;
  channelId: string;
  channelTitle: string;
  question: string;
  source: 'twin_unanswered' | 'direct' | 'comment';
  state: 'open' | 'answered' | 'dismissed';
  /** The asker's display name, only when they agreed to be named. */
  askerName: string | null;
  answerAssetId: string | null;
  createdAt: Date;
}

export async function listQuestions(workspaceId: string, options: { state?: PendingQuestion['state'] } = {}): Promise<PendingQuestion[]> {
  const rows = await db()
    .select({
      id: schema.channelQuestion.id,
      channelId: schema.channel.id,
      channelTitle: schema.channel.title,
      question: schema.channelQuestion.question,
      source: schema.channelQuestion.source,
      state: schema.channelQuestion.state,
      consent: schema.channelQuestion.askerNameConsent,
      displayName: schema.user.displayName,
      answerAssetId: schema.channelQuestion.answerAssetId,
      createdAt: schema.channelQuestion.createdAt,
    })
    .from(schema.channelQuestion)
    .innerJoin(schema.channel, eq(schema.channel.id, schema.channelQuestion.channelId))
    .leftJoin(schema.user, eq(schema.user.id, schema.channelQuestion.askerUserId))
    .where(
      and(
        eq(schema.channel.workspaceId, workspaceId),
        options.state ? eq(schema.channelQuestion.state, options.state) : undefined,
      ),
    )
    .orderBy(desc(schema.channelQuestion.createdAt))
    .limit(200);
  return rows.map(({ consent, displayName, ...row }) => ({ ...row, askerName: consent ? displayName?.trim() || null : null }));
}

/** Open questions across the workspace's channels: the sidebar's badge. */
export async function countOpenQuestions(workspaceId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.channelQuestion)
    .innerJoin(schema.channel, eq(schema.channel.id, schema.channelQuestion.channelId))
    .where(and(eq(schema.channel.workspaceId, workspaceId), eq(schema.channelQuestion.state, 'open')));
  return row?.n ?? 0;
}

async function ownedQuestion(workspaceId: string, role: WorkspaceRole, questionId: string) {
  if (!canManageLibraries(role)) throw new QuestionRefused('not_owner', 'only the creator answers questions');
  if (!UUID.test(questionId)) throw new QuestionRefused('not_found', 'no such question');
  const [row] = await db()
    .select({
      id: schema.channelQuestion.id,
      channelId: schema.channelQuestion.channelId,
      question: schema.channelQuestion.question,
      state: schema.channelQuestion.state,
      askerUserId: schema.channelQuestion.askerUserId,
      handle: schema.workspace.handle,
    })
    .from(schema.channelQuestion)
    .innerJoin(schema.channel, eq(schema.channel.id, schema.channelQuestion.channelId))
    .innerJoin(schema.workspace, eq(schema.workspace.id, schema.channel.workspaceId))
    .where(and(eq(schema.channelQuestion.id, questionId), eq(schema.channel.workspaceId, workspaceId)));
  if (!row) throw new QuestionRefused('not_found', 'no such question');
  return row;
}

export async function dismissQuestion(input: { workspaceId: string; role: WorkspaceRole; questionId: string }): Promise<void> {
  const row = await ownedQuestion(input.workspaceId, input.role, input.questionId);
  if (row.state !== 'open') return;
  await db().update(schema.channelQuestion).set({ state: 'dismissed' }).where(eq(schema.channelQuestion.id, row.id));
}

/**
 * Publishes the creator's written answer as a `qa` asset in the question's
 * channel, free or paid. Returns the build to run after the response. An
 * audio note can be attached to the Q&A afterwards (`refreshQaDocument`);
 * it is not transcribed.
 */
export async function answerQuestion(input: {
  workspaceId: string;
  role: WorkspaceRole;
  userId: string | null;
  questionId: string;
  answer: unknown;
  access?: unknown;
}): Promise<{ assetId: string; publicId: string; operationId: string }> {
  const row = await ownedQuestion(input.workspaceId, input.role, input.questionId);
  if (row.state === 'answered') throw new QuestionRefused('already_answered', 'this question has an answer');
  const answer = typeof input.answer === 'string' ? input.answer.trim() : '';
  if (answer.length === 0 || answer.length > EDITORIAL_LIMITS.answerMax) {
    throw new QuestionRefused('invalid_answer', `an answer is 1 to ${EDITORIAL_LIMITS.answerMax} characters`);
  }
  if (!row.handle) throw new EditorialRefused('no_handle', 'set a public handle for this workspace first');
  const access: AssetAccess = isAssetAccess(input.access) ? input.access : 'free';
  await assertBuildAffordable({ workspaceId: input.workspaceId, fetchesPages: false });

  const assetId = uuidv7();
  const publicId = editorialPublicId('qa', row.handle, `q-${assetId.replace(/-/g, '').slice(-10)}`);
  const title = row.question.length > EDITORIAL_LIMITS.titleMax ? `${row.question.slice(0, EDITORIAL_LIMITS.titleMax - 1)}…` : row.question;
  await db().transaction(async (tx) => {
    await tx.insert(schema.library).values({
      id: assetId,
      publicId,
      title,
      ownerWorkspaceId: input.workspaceId,
      isPlatformLibrary: false,
      kind: 'qa',
      lifecycleStatus: 'draft',
      indexStatus: 'pending',
      /* The answer is the creator's own words, written here by them (requirement.md 7.1). */
      rightsDeclaration: {
        origin: 'own',
        license: 'granted',
        generation: 'human',
        note: 'Answer written by the creator in re0',
        declaredAt: new Date().toISOString(),
        declaredBy: input.userId,
      },
    });
    await tx.insert(schema.source).values({
      id: uuidv7(),
      libraryId: assetId,
      type: 'editor',
      location: publicId,
      config: { path: 'qa.md', url: `/assets${publicId}`, markdown: qaDocument({ question: row.question, answer }), question: row.question, answer },
    });
  });
  /*
   * Into the channel before the question counts as answered: a move the
   * channel refuses (suspended, say) must leave the question open and no
   * stray Q&A behind, so the new rows are removed and the refusal stands.
   */
  try {
    await moveAsset({ workspaceId: input.workspaceId, role: input.role, assetId, channelId: row.channelId });
    if (access === 'paid') await setAssetAccess({ workspaceId: input.workspaceId, role: input.role, assetId, access });
  } catch (error) {
    await db().transaction(async (tx) => {
      await tx.delete(schema.channelAsset).where(eq(schema.channelAsset.assetId, assetId));
      await tx.delete(schema.source).where(eq(schema.source.libraryId, assetId));
      await tx.delete(schema.library).where(eq(schema.library.id, assetId));
    });
    throw error;
  }
  const operationId = await db().transaction(async (tx) => {
    await tx
      .update(schema.channelQuestion)
      .set({ state: 'answered', answerAssetId: assetId, answeredAt: new Date() })
      .where(eq(schema.channelQuestion.id, row.id));
    if (row.askerUserId) await notify([row.askerUserId], 'question_answered', { assetId, publicId, title }, tx);
    return queueBuildUnlessPending(tx, assetId);
  });
  return { assetId, publicId, operationId };
}

/**
 * After an audio note is attached to a Q&A: the document's path takes the
 * file's hash, so the next version's digest covers it. The text indexed is
 * unchanged -- the audio is not transcribed.
 */
export async function refreshQaDocument(input: { workspaceId: string; role: WorkspaceRole; assetId: string }): Promise<string | null> {
  if (!canManageLibraries(input.role)) throw new QuestionRefused('not_owner', 'only the creator edits a Q&A');
  if (!UUID.test(input.assetId)) throw new QuestionRefused('not_found', 'no such Q&A');
  return db().transaction(async (tx) => {
    const [source] = await tx
      .select({ id: schema.source.id, config: schema.source.config })
      .from(schema.source)
      .innerJoin(schema.library, eq(schema.library.id, schema.source.libraryId))
      .where(and(eq(schema.library.id, input.assetId), eq(schema.library.ownerWorkspaceId, input.workspaceId), eq(schema.library.kind, 'qa')));
    if (!source) throw new QuestionRefused('not_found', 'no such Q&A');
    const [audio] = await tx
      .select({ id: schema.assetMedia.id, sha256: schema.assetMedia.sha256 })
      .from(schema.assetMedia)
      .where(and(eq(schema.assetMedia.assetId, input.assetId), eq(schema.assetMedia.kind, 'audio'), eq(schema.assetMedia.state, 'ready')))
      .limit(1);
    const path = audio?.sha256 ? `qa-${audio.sha256}.md` : 'qa.md';
    if (source.config.path === path) return null;
    await tx
      .update(schema.source)
      .set({ config: { ...source.config, path, audioMediaId: audio?.id ?? null } })
      .where(eq(schema.source.id, source.id));
    return queueBuildUnlessPending(tx, input.assetId);
  });
}

/** Who asked a Q&A's question, for its page: a name only with the asker's consent. */
export async function qaAsker(assetId: string): Promise<{ question: string; askerName: string | null } | null> {
  if (!UUID.test(assetId)) return null;
  const [row] = await db()
    .select({ question: schema.channelQuestion.question, consent: schema.channelQuestion.askerNameConsent, name: schema.user.displayName })
    .from(schema.channelQuestion)
    .leftJoin(schema.user, eq(schema.user.id, schema.channelQuestion.askerUserId))
    .where(eq(schema.channelQuestion.answerAssetId, assetId));
  return row ? { question: row.question, askerName: row.consent ? row.name?.trim() || null : null } : null;
}

/* ------------------------------------------------------------ 作者确认 */

export interface TwinAnswerView {
  id: string;
  question: string;
  outcome: 'answer' | 'degraded' | 'no_context';
  claims: { claim: string; chunkIds: string[] }[];
  versions: { assetId: string; publicId: string; title: string; versionId: string; label: string }[];
  createdAt: Date;
  endorsement: Endorsement | null;
}

export interface Endorsement {
  versionLabel: string | null;
  /** True when the asset has moved on since: the mark still shows, naming its version. */
  superseded: boolean;
  createdAt: Date;
}

export async function endorsementsFor(twinAnswerIds: readonly string[]): Promise<Map<string, Endorsement>> {
  const found = new Map<string, Endorsement>();
  if (twinAnswerIds.length === 0) return found;
  const rows = await db()
    .select({
      answerRef: schema.answerEndorsement.answerRef,
      versionId: schema.answerEndorsement.versionId,
      versionLabel: schema.answerEndorsement.versionLabel,
      createdAt: schema.answerEndorsement.createdAt,
      currentVersionId: schema.library.currentVersionId,
    })
    .from(schema.answerEndorsement)
    .leftJoin(schema.libraryVersion, eq(schema.libraryVersion.id, schema.answerEndorsement.versionId))
    .leftJoin(schema.library, eq(schema.library.id, schema.libraryVersion.libraryId))
    .where(inArray(schema.answerEndorsement.answerRef, [...twinAnswerIds]));
  for (const row of rows) {
    found.set(row.answerRef, {
      versionLabel: row.versionLabel,
      superseded: row.versionId === null || row.currentVersionId !== row.versionId,
      createdAt: row.createdAt,
    });
  }
  return found;
}

/** The creator's view of what the twin said lately, to endorse from. */
export async function recentTwinAnswers(workspaceId: string, limit = 50): Promise<TwinAnswerView[]> {
  const rows = await db()
    .select({
      id: schema.twinAnswer.id,
      question: schema.twinAnswer.question,
      outcome: schema.twinAnswer.outcome,
      claims: schema.twinAnswer.claims,
      versions: schema.twinAnswer.versions,
      createdAt: schema.twinAnswer.createdAt,
    })
    .from(schema.twinAnswer)
    .innerJoin(schema.channel, eq(schema.channel.id, schema.twinAnswer.channelId))
    .where(and(eq(schema.channel.workspaceId, workspaceId), eq(schema.twinAnswer.outcome, 'answer')))
    .orderBy(desc(schema.twinAnswer.createdAt))
    .limit(limit);
  const endorsements = await endorsementsFor(rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, endorsement: endorsements.get(row.id) ?? null }));
}

/**
 * 作者确认: bound to the version the answer used most -- the first of its
 * versions. Only an answer the twin actually gave can be endorsed.
 */
export async function endorseTwinAnswer(input: {
  workspaceId: string;
  role: WorkspaceRole;
  userId: string | null;
  twinAnswerId: string;
  endorse: boolean;
}): Promise<void> {
  if (!canManageLibraries(input.role)) throw new QuestionRefused('not_owner', 'only the creator endorses an answer');
  if (!UUID.test(input.twinAnswerId)) throw new QuestionRefused('not_found', 'no such answer');
  const [row] = await db()
    .select({ id: schema.twinAnswer.id, channelId: schema.twinAnswer.channelId, outcome: schema.twinAnswer.outcome, versions: schema.twinAnswer.versions })
    .from(schema.twinAnswer)
    .innerJoin(schema.channel, eq(schema.channel.id, schema.twinAnswer.channelId))
    .where(and(eq(schema.twinAnswer.id, input.twinAnswerId), eq(schema.channel.workspaceId, input.workspaceId)));
  if (!row || row.outcome !== 'answer') throw new QuestionRefused('not_found', 'no such answer');
  if (!input.endorse) {
    await db().delete(schema.answerEndorsement).where(eq(schema.answerEndorsement.answerRef, row.id));
    return;
  }
  const version = row.versions[0];
  if (!version) throw new AppError('invalid_request', 'the answer cites no version');
  await db()
    .insert(schema.answerEndorsement)
    .values({ id: uuidv7(), channelId: row.channelId, answerRef: row.id, versionId: version.versionId, versionLabel: version.label, endorsedBy: input.userId })
    .onConflictDoNothing({ target: schema.answerEndorsement.answerRef });
}

/** The reader's own recent twin answers on a channel, with any 作者确认, for the channel page. */
export async function readerTwinAnswers(userId: string | null, channelId: string, limit = 5): Promise<TwinAnswerView[]> {
  if (!userId || !UUID.test(channelId)) return [];
  const rows = await db()
    .select({
      id: schema.twinAnswer.id,
      question: schema.twinAnswer.question,
      outcome: schema.twinAnswer.outcome,
      claims: schema.twinAnswer.claims,
      versions: schema.twinAnswer.versions,
      createdAt: schema.twinAnswer.createdAt,
    })
    .from(schema.twinAnswer)
    .where(and(eq(schema.twinAnswer.channelId, channelId), eq(schema.twinAnswer.askerUserId, userId)))
    .orderBy(desc(schema.twinAnswer.createdAt))
    .limit(limit);
  const endorsements = await endorsementsFor(rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, endorsement: endorsements.get(row.id) ?? null }));
}

