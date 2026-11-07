/**
 * One question to one or more Rees, streamed (rebuild-proposal.md 5; 7,
 * "问答生成").
 *
 *   1. A Ree without ready knowledge says so ("knowledge not ready"); nothing
 *      is held for it.
 *   2. For every other asked Ree, hold the most it can cost -- the base fee,
 *      and the owner's query fee on someone else's Ree, held apart -- all in
 *      one transaction with the question. Not enough credits for all of
 *      them → 402 before any stream starts, and the question is not saved.
 *   3. Every Ree then works on its own and at the same time: its own
 *      retrieval, its own persona, only its own earlier turns, never the
 *      others' answers. No evidence, or the model declines with the
 *      sentinel → no answer, its holds released.
 *   4. An answer settles that Ree's holds at "20 + query fee" and credits
 *      the query fee to the owner as earned credits (2.3). Each reply is
 *      stored with its citation snapshots.
 *   5. When nobody could answer, the public Rees that might know are
 *      suggested under the question (2.4, "对话里的兜底").
 *
 * Usage tokens go to the log only; users pay fixed credits (7, "计费对接").
 */
import { randomUUID } from 'node:crypto';
import { createUIMessageStream, createUIMessageStreamResponse, streamText, type UIMessageStreamWriter } from 'ai';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { NO_ANSWER_SUGGESTIONS, QUERY_BASE_FEE } from '@/lib/constants';
import { citationSnapshots, instructionsFor, questionWithPassages, sentinelState } from '@/lib/domain/answer';
import { TEXT_META_KEY, textPartId, type InsufficientCreditsBody, type ReeOutcome, type ReeUIMessage, type SuggestedRee } from '@/lib/domain/chat-message';
import { autoTitle, withoutMentions } from '@/lib/domain/conversation';
import { InsufficientCredits } from '@/lib/domain/credits';
import { generationForUser } from '@/lib/services/generation';
import { db, schema } from '@/lib/infra/db';
import { json } from '@/lib/http/respond';
import { embedQuestion, messagesOf, retrieve, turnsOf, type Conversation, type MessageRow, type QuestionVector } from '@/lib/services/chat';
import { addGrant, balanceOf, placeHold, releaseHold, settleHold } from '@/lib/services/credits';
import { suggestRees } from '@/lib/services/explore';
import type { Ree } from '@/lib/services/rees';

type Writer = UIMessageStreamWriter<ReeUIMessage>;
type Write = (chunk: Parameters<Writer['write']>[0]) => void;

const MAX_OUTPUT_TOKENS = 1_500;

/** The most a question to this Ree can cost this user: the base fee, plus the query fee when it is not theirs. */
export function maxCostFor(ree: Pick<Ree, 'ownerId' | 'queryFee'>, userId: string): number {
  return QUERY_BASE_FEE + feeFor(ree, userId);
}

function feeFor(ree: Pick<Ree, 'ownerId' | 'queryFee'>, userId: string): number {
  return ree.ownerId === userId ? 0 : ree.queryFee;
}

function outcome(reeId: string, partial: Partial<ReeOutcome>): ReeOutcome {
  return { reeId, messageId: null, noAnswer: false, reason: null, cost: 0, citations: [], model: null, failed: false, vote: null, ...partial };
}

/** Writes are best effort: a reader who left mid-answer must not stop the settlement. */
function safe(writer: Writer): Write {
  return (chunk) => {
    try {
      writer.write(chunk);
    } catch {
      /* the client went away */
    }
  };
}

interface Held {
  ree: Ree;
  baseHold: string;
  feeHold: string | null;
  fee: number;
}

/** Rees among these with at least one source answers may use. */
async function readyRees(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db()
    .selectDistinct({ reeId: schema.knowledge.reeId })
    .from(schema.knowledge)
    .where(and(inArray(schema.knowledge.reeId, [...ids]), eq(schema.knowledge.status, 'ready'), eq(schema.knowledge.enabled, true), isNull(schema.knowledge.deletedAt)));
  return new Set(rows.map((row) => row.reeId));
}

export async function answer(input: {
  userId: string;
  lang: 'zh' | 'en';
  conversation: Conversation;
  /** Who this question is for, already resolved from `@`, "只问这个 Ree" and the participants. */
  targets: Ree[];
  question: string;
}): Promise<Response> {
  const { userId, conversation, targets, question } = input;
  /* What is asked, without the `@name`s that only say who is asked. */
  const subject = withoutMentions(question, targets.map((ree) => ree.name));
  const database = db();
  const ready = await readyRees(targets.map((ree) => ree.id));
  const asking = targets.filter((ree) => ready.has(ree.id));
  const needed = asking.reduce((sum, ree) => sum + maxCostFor(ree, userId), 0);

  let askedId: string;
  let held: Held[];
  try {
    ({ askedId, held } = await database.transaction(async (tx) => {
      const [asked] = await tx
        .insert(schema.message)
        .values({ conversationId: conversation.id, role: 'user', content: question })
        .returning({ id: schema.message.id });
      const holds: Held[] = [];
      for (const ree of asking) {
        const fee = feeFor(ree, userId);
        const baseHold = await placeHold(tx, { userId, kind: 'chat', amount: QUERY_BASE_FEE, refId: asked!.id, reeId: ree.id, note: ree.name });
        const feeHold = fee > 0 ? await placeHold(tx, { userId, kind: 'chat', ledger: 'chat_fee', amount: fee, refId: asked!.id, reeId: ree.id, note: ree.name }) : null;
        holds.push({ ree, baseHold, feeHold, fee });
      }
      /* A question brings an archived conversation back to Recent (8.2); the first one names it. */
      await tx
        .update(schema.conversation)
        .set({
          updatedAt: new Date(),
          archivedAt: null,
          ...(conversation.kind === 'normal' && !conversation.title ? { title: autoTitle(question) } : {}),
        })
        .where(eq(schema.conversation.id, conversation.id));
      return { askedId: asked!.id, held: holds };
    }));
  } catch (error) {
    if (error instanceof InsufficientCredits) {
      const body: InsufficientCreditsBody = { error: 'insufficient_credits', balance: await balanceOf(database, userId), needed };
      return json(body, 402);
    }
    throw error;
  }

  const release = async (entry: Held) => {
    await database.transaction(async (tx) => {
      await releaseHold(tx, entry.baseHold, { reeId: entry.ree.id, note: entry.ree.name });
      if (entry.feeHold) await releaseHold(tx, entry.feeHold, { reeId: entry.ree.id, note: entry.ree.name, ledger: 'chat_fee' });
    });
  };

  const unanswered = async (ree: Ree, reason: 'no_sources' | 'out_of_scope', entry: Held | null): Promise<ReeOutcome> => {
    const row = await database.transaction(async (tx) => {
      if (entry) {
        await releaseHold(tx, entry.baseHold, { reeId: ree.id, note: ree.name });
        if (entry.feeHold) await releaseHold(tx, entry.feeHold, { reeId: ree.id, note: ree.name, ledger: 'chat_fee' });
      }
      const [reply] = await tx
        .insert(schema.message)
        .values({ conversationId: conversation.id, role: 'ree', reeId: ree.id, content: '', noAnswer: true, noAnswerReason: reason, requestId: askedId })
        .returning({ id: schema.message.id });
      return reply!;
    });
    return outcome(ree.id, { messageId: row.id, noAnswer: true, reason });
  };

  /* All Rees in one question use the asking user's membership and the same model. */
  let generationRequest: ReturnType<typeof generationForUser> | undefined;
  /** One Ree, start to finish; answers whether it gave an answer (or broke off trying), so suggestions follow only a clean "nobody knows". */
  const run = async (ree: Ree, write: Write, vector: Promise<QuestionVector> | null, history: Promise<MessageRow[]>): Promise<boolean> => {
    const entry = held.find((candidate) => candidate.ree.id === ree.id) ?? null;
    if (!entry) {
      write({ type: 'data-outcome', id: `outcome-${ree.id}`, data: await unanswered(ree, 'no_sources', null) });
      return false;
    }
    const partId = textPartId(ree.id);
    const meta = { [TEXT_META_KEY]: { reeId: ree.id } };
    let model: string | null = null;
    let textOpen = false;
    try {
      const found = await retrieve(ree.id, subject, await vector!);
      if (!found.evidence) {
        write({ type: 'data-outcome', id: `outcome-${ree.id}`, data: await unanswered(ree, 'out_of_scope', entry) });
        return false;
      }
      const generation = await (generationRequest ??= generationForUser(userId, 'answer'));
      model = generation.endpoint.model;
      console.info(
        `answer ree=${ree.id} model=${generation.endpoint.model} source=${generation.endpoint.source} config=${generation.endpoint.configId ?? '-'} passages=${found.passages.length} best=${found.bestSimilarity?.toFixed(3) ?? '-'}`,
      );
      const turns = turnsOf(await history, ree.id);
      const result = streamText({
        model: generation.model,
        instructions: instructionsFor({ reeName: ree.name, systemPrompt: ree.systemPrompt, lang: input.lang }),
        messages: [{ role: 'user', content: questionWithPassages(subject, found.passages, turns) }],
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.2,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(Math.max(generation.endpoint.timeoutMs, 30_000) * 2),
      });

      let decided: boolean | null = null;
      let pending = '';
      let streamed = '';
      for await (const delta of result.textStream) {
        if (decided === true) continue;
        if (decided === null) {
          pending += delta;
          decided = sentinelState(pending);
          if (decided !== false) continue;
          write({ type: 'text-start', id: partId, providerMetadata: meta });
          textOpen = true;
          write({ type: 'text-delta', id: partId, delta: pending });
          streamed += pending;
          continue;
        }
        write({ type: 'text-delta', id: partId, delta });
        streamed += delta;
      }
      if (textOpen) write({ type: 'text-end', id: partId });
      textOpen = false;
      void Promise.resolve(result.usage).then(
        (usage) => console.info(`answer usage ree=${ree.id} model=${model} in=${usage.inputTokens ?? 0} out=${usage.outputTokens ?? 0}`),
        () => undefined,
      );

      if (decided === true || streamed.trim().length === 0) {
        write({ type: 'data-outcome', id: `outcome-${ree.id}`, data: { ...(await unanswered(ree, 'out_of_scope', entry)), model } });
        return false;
      }

      const citations = citationSnapshots(streamed, found.passages);
      const replyId = randomUUID();
      const cost = await database.transaction(async (tx) => {
        const base = await settleHold(tx, entry.baseHold, QUERY_BASE_FEE, { reeId: ree.id, note: ree.name });
        const paid = entry.feeHold ? await settleHold(tx, entry.feeHold, entry.fee, { reeId: ree.id, note: ree.name, ledger: 'chat_fee' }) : null;
        /* The query fee goes to the owner in full, as earned credits; an open refund debt of theirs is paid from it first. */
        if (paid && paid.charged > 0) {
          await addGrant(tx, { userId: ree.ownerId, source: 'earned', amount: paid.charged, reason: 'query_fee_earned', refId: replyId, reeId: ree.id, note: ree.name });
        }
        const charged = (base?.charged ?? 0) + (paid?.charged ?? 0);
        await tx.insert(schema.message).values({
          id: replyId,
          conversationId: conversation.id,
          role: 'ree',
          reeId: ree.id,
          content: streamed,
          citations,
          requestId: askedId,
          costCredits: charged,
        });
        return charged;
      });
      write({ type: 'data-outcome', id: `outcome-${ree.id}`, data: outcome(ree.id, { messageId: replyId, cost, citations, model }) });
      return true;
    } catch (error) {
      console.warn(`answer ree=${ree.id} failed: ${error instanceof Error ? error.message : 'unknown'}`);
      await release(entry).catch(() => undefined);
      if (textOpen) write({ type: 'text-end', id: partId });
      write({ type: 'data-outcome', id: `outcome-${ree.id}`, data: outcome(ree.id, { failed: true, model }) });
      return true;
    }
  };

  const stream = createUIMessageStream<ReeUIMessage>({
    execute: async ({ writer }) => {
      const write = safe(writer);
      write({ type: 'start', messageId: `${askedId}-replies` });
      for (const ree of targets) write({ type: 'data-ree', id: ree.id, data: { reeId: ree.id } });
      const vector = asking.length ? embedQuestion(subject) : null;
      /* A failed embedding fails every Ree on its own path; nothing is left unhandled. */
      vector?.catch(() => undefined);
      /* The conversation is read once; each Ree takes only its own turns from it. */
      const history = messagesOf(conversation.id);
      history.catch(() => undefined);
      const results = await Promise.all(targets.map((ree) => run(ree, write, vector, history)));
      if (conversation.kind === 'normal' && !results.some(Boolean)) {
        const suggested = await suggestionsFor(userId, conversation.id, subject, vector).catch(() => []);
        if (suggested.length) {
          await database.update(schema.message).set({ suggestedReeIds: suggested.map((ree) => ree.id) }).where(eq(schema.message.id, askedId));
          write({ type: 'data-suggestions', id: 'suggestions', data: { rees: suggested } });
        }
      }
      write({ type: 'finish' });
    },
    onError: () => 'answer_failed',
  });
  return createUIMessageStreamResponse({ stream });
}

/** Public Rees, not already in the conversation, that might know (explore's search on the same question). */
async function suggestionsFor(userId: string, conversationId: string, question: string, vector: Promise<QuestionVector> | null): Promise<SuggestedRee[]> {
  const present = await db().select({ reeId: schema.conversationRee.reeId }).from(schema.conversationRee).where(eq(schema.conversationRee.conversationId, conversationId));
  return suggestRees({
    question,
    vector: vector ? await vector : await embedQuestion(question),
    viewerId: userId,
    exclude: present.map((row) => row.reeId),
    limit: NO_ANSWER_SUGGESTIONS,
  });
}

/** Saved suggestions for questions in a conversation, as they look now (a Ree since made private drops out). */
export async function storedSuggestions(userId: string, rows: readonly { id: string; role: string; suggestedReeIds: string[] }[]): Promise<Map<string, SuggestedRee[]>> {
  const wanted = rows.filter((row) => row.role === 'user' && row.suggestedReeIds.length);
  const ids = [...new Set(wanted.flatMap((row) => row.suggestedReeIds))];
  if (ids.length === 0) return new Map();
  const found = await db()
    .select({
      id: schema.ree.id,
      slug: schema.ree.slug,
      name: schema.ree.name,
      description: schema.ree.description,
      avatarBlob: schema.ree.avatarBlob,
      color: schema.ree.color,
      role: schema.user.role,
      ownerId: schema.ree.ownerId,
      queryFee: schema.ree.queryFee,
    })
    .from(schema.ree)
    .innerJoin(schema.user, eq(schema.user.id, schema.ree.ownerId))
    .where(and(inArray(schema.ree.id, ids), eq(schema.ree.isPublic, true), eq(schema.ree.isPublished, true), isNull(schema.ree.moderatedAt), isNull(schema.ree.deletedAt)));
  const byId = new Map<string, SuggestedRee>(
    found.map((ree) => [ree.id, { id: ree.id, slug: ree.slug, name: ree.name, description: ree.description, avatarBlob: ree.avatarBlob, color: ree.color, role: ree.role, price: maxCostFor(ree, userId) }]),
  );
  return new Map(wanted.map((row) => [row.id, row.suggestedReeIds.flatMap((id) => byId.get(id) ?? [])]));
}
