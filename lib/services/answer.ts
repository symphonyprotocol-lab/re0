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
 *   6. 回答核验, when asked for: each answering Ree's check fee is held with
 *      the rest; once its answer is settled, its cited sentences are checked
 *      against the full passages still in memory, the result stored on the
 *      reply, and the fee settled -- or given back when the Ree did not
 *      answer or the check failed (ree-council-proposal.md 3).
 *
 * Usage tokens go to the log only; users pay fixed credits (7, "计费对接").
 *
 * Steps 1-2 are `holdQuestion`, 3-6 `runQuestion`, which reports through
 * adapter-neutral events. Two adapters read them: `answer`, the web's
 * `useChat` stream, and `collectAnswer`, which the MCP server waits on.
 */
import { randomUUID } from 'node:crypto';
import { createUIMessageStream, createUIMessageStreamResponse, generateText, Output, streamText, type UIMessageStreamWriter } from 'ai';
import { z } from 'zod';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { NO_ANSWER_SUGGESTIONS, QUERY_BASE_FEE, VERIFY_ENABLED, VERIFY_FEE, VERIFY_MAX_SENTENCES, VERIFY_REASON_CHARS } from '@/lib/constants';
import {
  checkInstructions,
  checkPrompt,
  checkSummary,
  checkResults,
  citationSnapshots,
  instructionsFor,
  NO_ANSWER_SENTINEL,
  questionWithPassages,
  reasonLanguage,
  isNoAnswer,
  sentinelState,
  splitSentences,
  withoutSentinel,
  type Passage,
} from '@/lib/domain/answer';
import { checkPartId, TEXT_META_KEY, textPartId, type InsufficientCreditsBody, type ReeCheck, type ReeOutcome, type ReeUIMessage, type SuggestedRee } from '@/lib/domain/chat-message';
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
const CHECK_OUTPUT_TOKENS = 2_000;

/** Loose on purpose: `checkResults` keeps only what fits the sentences asked about. */
const CHECK_SCHEMA = z.object({
  sentences: z.array(
    z.object({
      id: z.number().describe('The sentence id.'),
      verdict: z.string().describe('supported, partial or unsupported for a sentence that cites passages; claim or not_claim for one that cites nothing.'),
      reason: z.string().optional().describe('At most 80 characters; empty for claim and not_claim.'),
    }),
  ),
});

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
/** A writer that ignores a client that went away; the stream carries on so the ledger is settled. */
export function safe(writer: Writer): Write {
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
  /** The check fee, when this question is checked. */
  verifyHold: string | null;
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

export interface AnswerInput {
  userId: string;
  lang: 'zh' | 'en';
  conversation: Conversation;
  /** Who this question is for, already resolved from `@`, "只问这个 Ree" and the participants. */
  targets: Ree[];
  question: string;
  /** 回答核验 for this question: "核对引用" in the composer, on by default in the test conversation. */
  verify?: boolean;
  /** The API key that asked, when the question came through the MCP server; stored on the question for per-key usage. */
  apiKeyId?: string | null;
}

/**
 * What the core flow reports while it answers, adapter-neutral: the web turns
 * it into `useChat` chunks, the MCP server collects it into one result.
 */
export type AnswerEvent =
  | { type: 'text-start'; reeId: string }
  | { type: 'text-delta'; reeId: string; delta: string }
  | { type: 'text-end'; reeId: string }
  | { type: 'outcome'; outcome: ReeOutcome }
  | { type: 'check'; check: ReeCheck }
  | { type: 'suggestions'; rees: SuggestedRee[] };
export type Emit = (event: AnswerEvent) => void;

/** A question saved with its holds placed, ready to be answered. */
export interface HeldQuestion {
  input: AnswerInput;
  askedId: string;
  held: Held[];
  /** The asked Rees with ready knowledge; the others answer "no sources" without a hold. */
  asking: Ree[];
  subject: string;
  verifying: boolean;
}

export type Holding = { ok: true; question: HeldQuestion } | { ok: false; balance: number; needed: number };

/**
 * Steps 1 and 2: the question and every hold in one transaction. Not enough
 * credits for all of them → nothing is saved and nothing is held.
 */
export async function holdQuestion(input: AnswerInput): Promise<Holding> {
  const { userId, conversation, targets, question } = input;
  const verifying = VERIFY_ENABLED && input.verify === true;
  /* What is asked, without the `@name`s that only say who is asked. */
  const subject = withoutMentions(question, targets.map((ree) => ree.name));
  const database = db();
  const ready = await readyRees(targets.map((ree) => ree.id));
  const asking = targets.filter((ree) => ready.has(ree.id));
  const needed = asking.reduce((sum, ree) => sum + maxCostFor(ree, userId) + (verifying ? VERIFY_FEE : 0), 0);

  try {
    const { askedId, held } = await database.transaction(async (tx) => {
      const [asked] = await tx
        .insert(schema.message)
        .values({ conversationId: conversation.id, role: 'user', content: question, apiKeyId: input.apiKeyId ?? null })
        .returning({ id: schema.message.id });
      const holds: Held[] = [];
      for (const ree of asking) {
        const fee = feeFor(ree, userId);
        const baseHold = await placeHold(tx, { userId, kind: 'chat', amount: QUERY_BASE_FEE, refId: asked!.id, reeId: ree.id, note: ree.name });
        const feeHold = fee > 0 ? await placeHold(tx, { userId, kind: 'chat', ledger: 'chat_fee', amount: fee, refId: asked!.id, reeId: ree.id, note: ree.name }) : null;
        const verifyHold = verifying ? await placeHold(tx, { userId, kind: 'chat', ledger: 'chat_verify', amount: VERIFY_FEE, refId: asked!.id, reeId: ree.id, note: ree.name }) : null;
        holds.push({ ree, baseHold, feeHold, fee, verifyHold });
      }
      /* A question brings an archived conversation back to Recent (8.2); the first one names it. */
      await tx
        .update(schema.conversation)
        .set({
          updatedAt: new Date(),
          archivedAt: null,
          ...((conversation.kind === 'normal' || conversation.kind === 'mcp') && !conversation.title ? { title: autoTitle(question) } : {}),
        })
        .where(eq(schema.conversation.id, conversation.id));
      return { askedId: asked!.id, held: holds };
    });
    return { ok: true, question: { input, askedId, held, asking, subject, verifying } };
  } catch (error) {
    if (error instanceof InsufficientCredits) return { ok: false, balance: await balanceOf(database, userId), needed };
    throw error;
  }
}

/**
 * Steps 3 to 6 for a held question: every asked Ree at once, each settled
 * or released on its own, then the suggestions when nobody could answer.
 * Resolves once every hold is closed; `emit` only reports.
 */
export async function runQuestion(question: HeldQuestion, emit: Emit): Promise<void> {
  const { input, askedId, asking, subject } = question;
  const { userId, conversation, targets } = input;
  const database = db();

  const release = async (entry: Held) => {
    await database.transaction(async (tx) => {
      await releaseHold(tx, entry.baseHold, { reeId: entry.ree.id, note: entry.ree.name });
      if (entry.feeHold) await releaseHold(tx, entry.feeHold, { reeId: entry.ree.id, note: entry.ree.name, ledger: 'chat_fee' });
      if (entry.verifyHold) await releaseHold(tx, entry.verifyHold, { reeId: entry.ree.id, note: entry.ree.name, ledger: 'chat_verify' });
    });
  };

  const unanswered = async (ree: Ree, reason: 'no_sources' | 'out_of_scope', entry: Held | null): Promise<ReeOutcome> => {
    const row = await database.transaction(async (tx) => {
      if (entry) {
        await releaseHold(tx, entry.baseHold, { reeId: ree.id, note: ree.name });
        if (entry.feeHold) await releaseHold(tx, entry.feeHold, { reeId: ree.id, note: ree.name, ledger: 'chat_fee' });
        if (entry.verifyHold) await releaseHold(tx, entry.verifyHold, { reeId: ree.id, note: ree.name, ledger: 'chat_verify' });
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
  let checkRequest: ReturnType<typeof generationForUser> | undefined;

  /**
   * 回答核验 of one settled answer. The check fee is settled with the result
   * stored on the reply, or given back when the model fails, times out or
   * returns nothing usable; the answer itself stands either way.
   */
  const check = async (entry: Held, replyId: string, text: string, passages: readonly Passage[]) => {
    const { ree } = entry;
    const holdId = entry.verifyHold!;
    const part = (data: Omit<ReeCheck, 'reeId' | 'messageId'>) => emit({ type: 'check', check: { reeId: ree.id, messageId: replyId, ...data } });
    const sentences = splitSentences(text, passages.length).slice(0, VERIFY_MAX_SENTENCES);
    try {
      /* Nothing that reads as a sentence: nothing to check, nothing charged. */
      if (sentences.length === 0) {
        await database.transaction(async (tx) => {
          await releaseHold(tx, holdId, { reeId: ree.id, note: ree.name, ledger: 'chat_verify' });
          await tx.update(schema.message).set({ checkState: 'done' }).where(eq(schema.message.id, replyId));
        });
        part({ state: 'done', checks: [], cost: 0 });
        return;
      }
      part({ state: 'pending', checks: [], cost: 0 });
      const generation = await (checkRequest ??= generationForUser(userId, 'verify'));
      const { output } = await generateText({
        model: generation.model,
        output: Output.object({ schema: CHECK_SCHEMA }),
        instructions: checkInstructions(reasonLanguage(text, input.lang)),
        prompt: checkPrompt(sentences, passages),
        maxOutputTokens: CHECK_OUTPUT_TOKENS,
        temperature: 0,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(Math.max(generation.endpoint.timeoutMs, 30_000)),
      });
      const { checks, judged } = checkResults(sentences, output, VERIFY_REASON_CHARS);
      if (judged === 0) throw new Error('no usable verdict');
      const cost = await database.transaction(async (tx) => {
        const charged = (await settleHold(tx, holdId, VERIFY_FEE, { reeId: ree.id, note: ree.name, ledger: 'chat_verify' }))?.charged ?? 0;
        await tx.update(schema.message).set({ checks, checkState: 'done', checkCredits: charged }).where(eq(schema.message.id, replyId));
        const { cited, unsupported, partial, uncited } = checkSummary(checks);
        await tx.insert(schema.answerCheck).values({ reeId: ree.id, messageId: replyId, cited, unsupported, partial, uncited });
        return charged;
      });
      part({ state: 'done', checks, cost });
    } catch (error) {
      console.warn(`check ree=${ree.id} failed: ${error instanceof Error ? error.message : 'unknown'}`);
      await database
        .transaction(async (tx) => {
          await releaseHold(tx, holdId, { reeId: ree.id, note: ree.name, ledger: 'chat_verify' });
          await tx.update(schema.message).set({ checkState: 'failed' }).where(eq(schema.message.id, replyId));
        })
        .catch(() => undefined);
      part({ state: 'failed', checks: [], cost: 0 });
    }
  };
  /** One Ree, start to finish; answers whether it gave an answer (or broke off trying), so suggestions follow only a clean "nobody knows". */
  const run = async (ree: Ree, vector: Promise<QuestionVector> | null, history: Promise<MessageRow[]>): Promise<boolean> => {
    const entry = question.held.find((candidate) => candidate.ree.id === ree.id) ?? null;
    if (!entry) {
      emit({ type: 'outcome', outcome: await unanswered(ree, 'no_sources', null) });
      return false;
    }
    let model: string | null = null;
    let textOpen = false;
    try {
      const found = await retrieve(ree.id, subject, await vector!);
      if (!found.evidence) {
        emit({ type: 'outcome', outcome: await unanswered(ree, 'out_of_scope', entry) });
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
      /* Everything the model wrote, sentinels included: a reply that ends on one is still no answer. */
      let raw = '';
      /* A sentinel written after the answer began is dropped, never shown or stored. */
      let held = '';
      const send = (text: string, flush = false) => {
        raw += text;
        const { send: out, keep } = flush ? { send: (held + text).split(NO_ANSWER_SENTINEL).join(''), keep: '' } : withoutSentinel(held + text);
        held = keep;
        if (!out) return;
        emit({ type: 'text-delta', reeId: ree.id, delta: out });
        streamed += out;
      };
      for await (const delta of result.textStream) {
        if (decided === true) continue;
        if (decided === null) {
          pending += delta;
          decided = sentinelState(pending);
          if (decided !== false) continue;
          emit({ type: 'text-start', reeId: ree.id });
          textOpen = true;
          send(pending);
          continue;
        }
        send(delta);
      }
      if (textOpen) send('', true);
      if (textOpen) emit({ type: 'text-end', reeId: ree.id });
      textOpen = false;
      void Promise.resolve(result.usage).then(
        (usage) => console.info(`answer usage ree=${ree.id} model=${model} in=${usage.inputTokens ?? 0} out=${usage.outputTokens ?? 0}`),
        () => undefined,
      );

      if (decided === true || isNoAnswer(raw)) {
        emit({ type: 'outcome', outcome: { ...(await unanswered(ree, 'out_of_scope', entry)), model } });
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
      emit({ type: 'outcome', outcome: outcome(ree.id, { messageId: replyId, cost, citations, model }) });
      if (entry.verifyHold) await check(entry, replyId, streamed, found.passages);
      return true;
    } catch (error) {
      console.warn(`answer ree=${ree.id} failed: ${error instanceof Error ? error.message : 'unknown'}`);
      await release(entry).catch(() => undefined);
      if (textOpen) emit({ type: 'text-end', reeId: ree.id });
      emit({ type: 'outcome', outcome: outcome(ree.id, { failed: true, model }) });
      return true;
    }
  };

  const vector = asking.length ? embedQuestion(subject) : null;
  /* A failed embedding fails every Ree on its own path; nothing is left unhandled. */
  vector?.catch(() => undefined);
  /* The conversation is read once; each Ree takes only its own turns from it. */
  const history = messagesOf(conversation.id);
  history.catch(() => undefined);
  const results = await Promise.all(targets.map((ree) => run(ree, vector, history)));
  if (conversation.kind === 'normal' && !results.some(Boolean)) {
    const suggested = await suggestionsFor(userId, conversation.id, subject, vector).catch(() => []);
    if (suggested.length) {
      await database.update(schema.message).set({ suggestedReeIds: suggested.map((ree) => ree.id) }).where(eq(schema.message.id, askedId));
      emit({ type: 'suggestions', rees: suggested });
    }
  }
}

/** The web adapter's chunk for one core event: each Ree in its own text part tagged with its id. */
function uiChunk(event: AnswerEvent): Parameters<Writer['write']>[0] {
  switch (event.type) {
    case 'text-start':
      return { type: 'text-start', id: textPartId(event.reeId), providerMetadata: { [TEXT_META_KEY]: { reeId: event.reeId } } };
    case 'text-delta':
      return { type: 'text-delta', id: textPartId(event.reeId), delta: event.delta };
    case 'text-end':
      return { type: 'text-end', id: textPartId(event.reeId) };
    case 'outcome':
      return { type: 'data-outcome', id: `outcome-${event.outcome.reeId}`, data: event.outcome };
    case 'check':
      return { type: 'data-check', id: checkPartId(event.check.reeId), data: event.check };
    case 'suggestions':
      return { type: 'data-suggestions', id: 'suggestions', data: { rees: event.rees } };
  }
}

/**
 * The web: one question as a `useChat` UI message stream, or 402 before any
 * stream starts when the credits do not cover every hold.
 */
export async function answer(input: AnswerInput): Promise<Response> {
  const holding = await holdQuestion(input);
  if (!holding.ok) {
    const body: InsufficientCreditsBody = { error: 'insufficient_credits', balance: holding.balance, needed: holding.needed };
    return json(body, 402);
  }
  const { question } = holding;
  const stream = createUIMessageStream<ReeUIMessage>({
    execute: async ({ writer }) => {
      const write = safe(writer);
      write({ type: 'start', messageId: `${question.askedId}-replies` });
      for (const ree of input.targets) write({ type: 'data-ree', id: ree.id, data: { reeId: ree.id } });
      await runQuestion(question, (event) => write(uiChunk(event)));
      write({ type: 'finish' });
    },
    onError: () => 'answer_failed',
  });
  return createUIMessageStreamResponse({ stream });
}

/** One Ree's part of a collected answer. */
export interface CollectedReply {
  text: string;
  outcome: ReeOutcome | null;
}

/**
 * The collecting adapter (the MCP server): runs a held question to the end
 * and answers each Ree's final text and outcome. `onEvent` sees every event
 * as it happens, for progress; it must not throw.
 */
export async function collectAnswer(question: HeldQuestion, onEvent?: Emit): Promise<Map<string, CollectedReply>> {
  const replies = new Map<string, CollectedReply>(question.input.targets.map((ree) => [ree.id, { text: '', outcome: null }]));
  await runQuestion(question, (event) => {
    if (event.type === 'text-delta') replies.get(event.reeId)!.text += event.delta;
    if (event.type === 'outcome') replies.get(event.outcome.reeId)!.outcome = event.outcome;
    try {
      onEvent?.(event);
    } catch {
      /* progress is best effort */
    }
  });
  return replies;
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
