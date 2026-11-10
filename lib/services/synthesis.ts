/**
 * Ree 圆桌 (ree-council-proposal.md 4): one synthesis of the answers several
 * Rees gave to one question, streamed.
 *
 *   1. The question must be the asker's, with at least two answers, and no
 *      synthesis yet. A running one that died long ago -- its function cut
 *      off mid-stream -- may be replaced; its fee goes back first.
 *   2. SYNTHESIS_FEE is held -- to the platform; the owners were paid when
 *      they answered -- in one transaction with the row that claims the
 *      question. Not enough credits → 402, nothing kept.
 *   3. The model sees the question, each answer and its citation excerpts,
 *      lettered A, B, C; nothing else. It never enters a Ree's history.
 *   4. When the stream ends, every `[A2]` is checked against the answers and
 *      mapped back to their snapshots; anything else is removed. A result
 *      with nothing left, or a failure, gives the fee back and deletes the
 *      row, so it can be tried again; otherwise the fee is settled.
 */
import { createUIMessageStream, createUIMessageStreamResponse, streamText, type UIMessageStreamWriter } from 'ai';
import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { SYNTHESIS_ENABLED, SYNTHESIS_FEE, SYNTHESIS_MIN_ANSWERS, SYNTHESIS_STALE_MS } from '@/lib/constants';
import { SYNTHESIS_PART_ID, type InsufficientCreditsBody, type ReeUIMessage, type SynthesisPart } from '@/lib/domain/chat-message';
import { InsufficientCredits } from '@/lib/domain/credits';
import { cleanSynthesis, letterAnswers, synthesisInstructions, synthesisPrompt, type SynthesisAnswer } from '@/lib/domain/synthesis';
import { fail, json } from '@/lib/http/respond';
import { db, schema } from '@/lib/infra/db';
import { safe } from '@/lib/services/answer';
import type { Conversation } from '@/lib/services/chat';
import { ConversationError } from '@/lib/services/conversations';
import { balanceOf, placeHold, releaseHold, settleHold } from '@/lib/services/credits';
import { generationForUser } from '@/lib/services/generation';

type Writer = UIMessageStreamWriter<ReeUIMessage>;

const MAX_OUTPUT_TOKENS = 1_500;
const TEXT_ID = 'synthesis-text';

/** The answers a synthesis of this question would draw on, lettered in the order they were given. */
export async function synthesisAnswers(conversationId: string, requestId: string): Promise<SynthesisAnswer[]> {
  const rows = await db()
    .select({ id: schema.message.id, reeId: schema.message.reeId, content: schema.message.content, citations: schema.message.citations, name: schema.ree.name })
    .from(schema.message)
    .innerJoin(schema.ree, eq(schema.ree.id, schema.message.reeId))
    .where(and(eq(schema.message.conversationId, conversationId), eq(schema.message.requestId, requestId), eq(schema.message.role, 'ree'), eq(schema.message.noAnswer, false)))
    .orderBy(asc(schema.message.createdAt));
  return letterAnswers(
    rows.filter((row) => row.content.trim()).map((row) => ({ reeId: row.reeId!, messageId: row.id, reeName: row.name, text: row.content, citations: row.citations })),
  );
}

export async function synthesize(input: { userId: string; lang: 'zh' | 'en'; conversation: Conversation; requestId: string }): Promise<Response> {
  const { userId, conversation, requestId } = input;
  if (!SYNTHESIS_ENABLED || conversation.kind !== 'normal' || !/^[0-9a-f-]{36}$/i.test(requestId)) return fail('not_found', 404);
  const database = db();
  const [asked] = await database
    .select({ id: schema.message.id, content: schema.message.content })
    .from(schema.message)
    .where(and(eq(schema.message.id, requestId), eq(schema.message.conversationId, conversation.id), eq(schema.message.role, 'user')))
    .limit(1);
  if (!asked) return fail('not_found', 404);
  const answers = await synthesisAnswers(conversation.id, requestId);
  if (answers.length < SYNTHESIS_MIN_ANSWERS) return fail('not_enough_answers', 422);

  let claimed: { synthesisId: string; holdId: string } | null;
  try {
    claimed = await database.transaction(async (tx) => {
      const stale = await tx
        .delete(schema.synthesis)
        .where(and(eq(schema.synthesis.requestId, requestId), eq(schema.synthesis.status, 'running'), lt(schema.synthesis.createdAt, new Date(Date.now() - SYNTHESIS_STALE_MS))))
        .returning({ id: schema.synthesis.id });
      /* Each synthesis holds its fee under its own id; one that died never gave it back. */
      if (stale.length) {
        const holds = await tx
          .select({ id: schema.creditHold.id })
          .from(schema.creditHold)
          .where(and(inArray(schema.creditHold.refId, stale.map((row) => row.id)), eq(schema.creditHold.status, 'held')));
        for (const hold of holds) await releaseHold(tx, hold.id, { note: 'synthesis', ledger: 'chat_synthesis' });
      }
      const [row] = await tx
        .insert(schema.synthesis)
        .values({ conversationId: conversation.id, requestId, userId, reeIds: answers.map((answer) => answer.reeId) })
        .onConflictDoNothing()
        .returning({ id: schema.synthesis.id });
      if (!row) return null;
      const holdId = await placeHold(tx, { userId, kind: 'chat', ledger: 'chat_synthesis', amount: SYNTHESIS_FEE, refId: row.id, note: 'synthesis' });
      return { synthesisId: row.id, holdId };
    });
  } catch (error) {
    if (error instanceof InsufficientCredits) {
      const body: InsufficientCreditsBody = { error: 'insufficient_credits', balance: await balanceOf(database, userId), needed: SYNTHESIS_FEE };
      return json(body, 402);
    }
    throw error;
  }
  if (!claimed) {
    const [existing] = await database.select({ status: schema.synthesis.status }).from(schema.synthesis).where(eq(schema.synthesis.requestId, requestId)).limit(1);
    return fail(existing?.status === 'done' ? 'already_synthesized' : 'synthesis_running', 409);
  }
  const { synthesisId, holdId } = claimed;
  const reeIds = answers.map((answer) => answer.reeId);
  const part = (data: Omit<SynthesisPart, 'requestId' | 'reeIds' | 'vote'>): Parameters<Writer['write']>[0] => ({
    type: 'data-synthesis',
    id: SYNTHESIS_PART_ID,
    data: { requestId, reeIds, vote: null, ...data },
  });

  const giveBack = async () => {
    await database.transaction(async (tx) => {
      await releaseHold(tx, holdId, { note: 'synthesis', ledger: 'chat_synthesis' });
      await tx.delete(schema.synthesis).where(eq(schema.synthesis.id, synthesisId));
    });
  };

  const stream = createUIMessageStream<ReeUIMessage>({
    execute: async ({ writer }) => {
      const write = safe(writer);
      write({ type: 'start', messageId: `${requestId}-synthesis` });
      /* Which Ree is A, B, C, before any text, so markers read right while it streams. */
      write(part({ synthesisId, state: 'streaming', content: '', sources: [], cost: 0 }));
      let model: string | null = null;
      let open = false;
      try {
        const generation = await generationForUser(userId, 'synthesis');
        model = generation.endpoint.model;
        const result = streamText({
          model: generation.model,
          instructions: synthesisInstructions(input.lang),
          messages: [{ role: 'user', content: synthesisPrompt(asked.content, answers) }],
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          temperature: 0.2,
          maxRetries: 1,
          abortSignal: AbortSignal.timeout(Math.max(generation.endpoint.timeoutMs, 30_000) * 2),
        });
        let streamed = '';
        /* The full stream: `textStream` drops `error` / `abort` parts, which would charge a cut-off synthesis (review M6). */
        for await (const chunk of result.stream) {
          if (chunk.type === 'error') throw chunk.error instanceof Error ? chunk.error : new Error(`stream error: ${String(chunk.error)}`);
          if (chunk.type === 'abort') throw new Error(`stream aborted${chunk.reason ? `: ${chunk.reason}` : ''}`);
          if (chunk.type === 'finish' && chunk.finishReason === 'error') throw new Error('stream finished with an error');
          if (chunk.type !== 'text-delta') continue;
          const delta = chunk.text;
          if (!open) {
            write({ type: 'text-start', id: TEXT_ID });
            open = true;
          }
          write({ type: 'text-delta', id: TEXT_ID, delta });
          streamed += delta;
        }
        if (open) write({ type: 'text-end', id: TEXT_ID });
        open = false;
        const { content, sources } = cleanSynthesis(streamed, answers);
        if (!content) throw new Error('empty synthesis');
        const cost = await database.transaction(async (tx) => {
          const charged = (await settleHold(tx, holdId, SYNTHESIS_FEE, { note: 'synthesis', ledger: 'chat_synthesis' }))?.charged ?? 0;
          await tx.update(schema.synthesis).set({ status: 'done', content, sources, costCredits: charged, model }).where(eq(schema.synthesis.id, synthesisId));
          return charged;
        });
        write(part({ synthesisId, state: 'done', content, sources, cost }));
      } catch (error) {
        console.warn(`synthesis request=${requestId} failed: ${error instanceof Error ? error.message : 'unknown'}`);
        if (open) write({ type: 'text-end', id: TEXT_ID });
        await giveBack().catch((failure: unknown) => console.error(`synthesis request=${requestId} hold not given back: ${failure instanceof Error ? failure.message : 'unknown'}`));
        write(part({ synthesisId: null, state: 'failed', content: '', sources: [], cost: 0 }));
      }
      write({ type: 'finish' });
    },
    onError: () => 'synthesis_failed',
  });
  return createUIMessageStreamResponse({ stream });
}

/** The finished syntheses of a conversation, by question, with the asker's own votes. */
export async function synthesesFor(userId: string, conversationId: string): Promise<Map<string, SynthesisPart>> {
  const rows = await db()
    .select()
    .from(schema.synthesis)
    .where(and(eq(schema.synthesis.conversationId, conversationId), eq(schema.synthesis.status, 'done')));
  if (rows.length === 0) return new Map();
  const votes = await db()
    .select({ synthesisId: schema.synthesisFeedback.synthesisId, vote: schema.synthesisFeedback.vote })
    .from(schema.synthesisFeedback)
    .where(and(eq(schema.synthesisFeedback.userId, userId), inArray(schema.synthesisFeedback.synthesisId, rows.map((row) => row.id))));
  const byId = new Map(votes.map((row) => [row.synthesisId, row.vote]));
  return new Map(
    rows.map((row) => [
      row.requestId,
      { synthesisId: row.id, requestId: row.requestId, state: 'done', content: row.content, reeIds: row.reeIds, sources: row.sources, cost: row.costCredits, vote: byId.get(row.id) ?? null },
    ]),
  );
}

/** "有用 / 没用" on a synthesis the user asked for; the same vote again takes it back. No Ree's rating sees it. */
export async function setSynthesisFeedback(userId: string, synthesisId: string, vote: 'up' | 'down' | null): Promise<'up' | 'down' | null> {
  if (!/^[0-9a-f-]{36}$/i.test(synthesisId)) throw new ConversationError('not_found', 404);
  const [row] = await db()
    .select({ id: schema.synthesis.id })
    .from(schema.synthesis)
    .where(and(eq(schema.synthesis.id, synthesisId), eq(schema.synthesis.userId, userId), eq(schema.synthesis.status, 'done')))
    .limit(1);
  if (!row) throw new ConversationError('not_found', 404);
  if (vote === null) {
    await db().delete(schema.synthesisFeedback).where(and(eq(schema.synthesisFeedback.synthesisId, synthesisId), eq(schema.synthesisFeedback.userId, userId)));
    return null;
  }
  await db()
    .insert(schema.synthesisFeedback)
    .values({ synthesisId, userId, vote })
    .onConflictDoUpdate({ target: [schema.synthesisFeedback.synthesisId, schema.synthesisFeedback.userId], set: { vote, createdAt: new Date() } });
  return vote;
}
