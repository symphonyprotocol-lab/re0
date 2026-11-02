/**
 * One question to one Ree, streamed (rebuild-proposal.md 5; 7, "问答生成").
 *
 *   1. No ready knowledge → a "knowledge not ready" card, nothing held.
 *   2. Hold the most the question can cost; not enough credits → 402 before
 *      any stream starts, and the question is not saved.
 *   3. Retrieve; no evidence → "outside my knowledge", hold released.
 *   4. Generate with numbered passages; the model may still decline with the
 *      sentinel, which releases the hold too. An answer settles the hold at
 *      the base fee (plus the owner's query fee, for someone else's Ree --
 *      step 4) and is stored with its citation snapshots.
 *
 * Usage tokens go to the log only; users pay fixed credits (7, "计费对接").
 */
import { createUIMessageStream, createUIMessageStreamResponse, streamText, type UIMessageStreamWriter } from 'ai';
import { eq } from 'drizzle-orm';
import { QUERY_BASE_FEE } from '@/lib/constants';
import { citationSnapshots, instructionsFor, questionWithPassages, sentinelState } from '@/lib/domain/answer';
import type { InsufficientCreditsBody, ReeOutcome, ReeUIMessage } from '@/lib/domain/chat-message';
import { InsufficientCredits } from '@/lib/domain/credits';
import { modelFor } from '@/lib/infra/ai/models';
import { db, schema } from '@/lib/infra/db';
import { json } from '@/lib/http/respond';
import { historyTurns, retrieve, type Conversation } from '@/lib/services/chat';
import { balanceOf, placeHold, releaseHold, settleHold } from '@/lib/services/credits';
import { readiness } from '@/lib/services/knowledge';
import type { Ree } from '@/lib/services/rees';

type Writer = UIMessageStreamWriter<ReeUIMessage>;

const MAX_OUTPUT_TOKENS = 1_500;

/** The most a question to this Ree can cost this user: the base fee, plus the query fee when it is not theirs. */
export function maxCostFor(ree: Pick<Ree, 'ownerId' | 'queryFee'>, userId: string): number {
  return QUERY_BASE_FEE + (ree.ownerId === userId ? 0 : ree.queryFee);
}

function outcome(partial: Partial<ReeOutcome>): ReeOutcome {
  return { messageId: null, noAnswer: false, reason: null, cost: 0, citations: [], model: null, failed: false, ...partial };
}

/** Writes are best effort: a reader who left mid-answer must not stop the settlement. */
function safe(writer: Writer) {
  return (chunk: Parameters<Writer['write']>[0]) => {
    try {
      writer.write(chunk);
    } catch {
      /* the client went away */
    }
  };
}

function oneShot(result: ReeOutcome): Response {
  const stream = createUIMessageStream<ReeUIMessage>({
    execute: ({ writer }) => {
      writer.write({ type: 'start' });
      writer.write({ type: 'data-outcome', data: result });
      writer.write({ type: 'finish' });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

export async function answer(input: {
  userId: string;
  lang: 'zh' | 'en';
  conversation: Conversation;
  ree: Ree;
  question: string;
}): Promise<Response> {
  const { userId, conversation, ree, question } = input;
  const database = db();
  const { ready } = await readiness(ree.id);

  if (ready === 0) {
    const row = await database.transaction(async (tx) => {
      const [asked] = await tx
        .insert(schema.message)
        .values({ conversationId: conversation.id, role: 'user', content: question })
        .returning({ id: schema.message.id });
      const [reply] = await tx
        .insert(schema.message)
        .values({
          conversationId: conversation.id,
          role: 'ree',
          reeId: ree.id,
          content: '',
          noAnswer: true,
          noAnswerReason: 'no_sources',
          requestId: asked!.id,
        })
        .returning({ id: schema.message.id });
      await tx.update(schema.conversation).set({ updatedAt: new Date() }).where(eq(schema.conversation.id, conversation.id));
      return reply!;
    });
    return oneShot(outcome({ messageId: row.id, noAnswer: true, reason: 'no_sources' }));
  }

  const needed = maxCostFor(ree, userId);
  let held: { askedId: string; holdId: string };
  try {
    held = await database.transaction(async (tx) => {
      const [asked] = await tx
        .insert(schema.message)
        .values({ conversationId: conversation.id, role: 'user', content: question })
        .returning({ id: schema.message.id });
      const holdId = await placeHold(tx, {
        userId,
        kind: 'chat',
        amount: needed,
        refId: asked!.id,
        reeId: ree.id,
        note: ree.name,
      });
      return { askedId: asked!.id, holdId };
    });
  } catch (error) {
    if (error instanceof InsufficientCredits) {
      const body: InsufficientCreditsBody = { error: 'insufficient_credits', balance: await balanceOf(database, userId), needed };
      return json(body, 402);
    }
    throw error;
  }

  const finishUnanswered = async (write: ReturnType<typeof safe>, reason: 'out_of_scope', model: string | null) => {
    const reply = await database.transaction(async (tx) => {
      await releaseHold(tx, held.holdId, { reeId: ree.id, note: ree.name });
      const [row] = await tx
        .insert(schema.message)
        .values({
          conversationId: conversation.id,
          role: 'ree',
          reeId: ree.id,
          content: '',
          noAnswer: true,
          noAnswerReason: reason,
          requestId: held.askedId,
        })
        .returning({ id: schema.message.id });
      await tx.update(schema.conversation).set({ updatedAt: new Date() }).where(eq(schema.conversation.id, conversation.id));
      return row!;
    });
    write({ type: 'data-outcome', data: outcome({ messageId: reply.id, noAnswer: true, reason, model }) });
  };

  const stream = createUIMessageStream<ReeUIMessage>({
    execute: async ({ writer }) => {
      const write = safe(writer);
      write({ type: 'start' });
      let model: string | null = null;
      let streamed = '';
      let textOpen = false;
      try {
        const found = await retrieve(ree.id, question);
        if (!found.evidence) {
          await finishUnanswered(write, 'out_of_scope', null);
          write({ type: 'finish' });
          return;
        }

        const generation = await modelFor('generation');
        model = generation.endpoint.model;
        console.info(
          `answer ree=${ree.id} model=${generation.endpoint.model} source=${generation.endpoint.source} config=${generation.endpoint.configId ?? '-'} passages=${found.passages.length} best=${found.bestSimilarity?.toFixed(3) ?? '-'}`,
        );
        const history = await historyTurns(conversation.id, ree.id);
        const result = streamText({
          model: generation.model,
          instructions: instructionsFor({ reeName: ree.name, systemPrompt: ree.systemPrompt, lang: input.lang }),
          messages: [
            ...history.filter((turn) => turn.content),
            { role: 'user', content: questionWithPassages(question, found.passages) },
          ],
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          temperature: 0.2,
          maxRetries: 1,
          abortSignal: AbortSignal.timeout(Math.max(generation.endpoint.timeoutMs, 30_000) * 2),
        });

        let decided: boolean | null = null;
        let pending = '';
        for await (const delta of result.textStream) {
          if (decided === true) continue;
          if (decided === null) {
            pending += delta;
            decided = sentinelState(pending);
            if (decided !== false) continue;
            write({ type: 'text-start', id: 'answer' });
            textOpen = true;
            write({ type: 'text-delta', id: 'answer', delta: pending });
            streamed += pending;
            continue;
          }
          write({ type: 'text-delta', id: 'answer', delta });
          streamed += delta;
        }
        if (textOpen) write({ type: 'text-end', id: 'answer' });
        void Promise.resolve(result.usage).then(
          (usage) => console.info(`answer usage ree=${ree.id} model=${model} in=${usage.inputTokens ?? 0} out=${usage.outputTokens ?? 0}`),
          () => undefined,
        );

        if (decided === true || streamed.trim().length === 0) {
          await finishUnanswered(write, 'out_of_scope', model);
          write({ type: 'finish' });
          return;
        }

        const citations = citationSnapshots(streamed, found.passages);
        const reply = await database.transaction(async (tx) => {
          const settled = await settleHold(tx, held.holdId, QUERY_BASE_FEE, { reeId: ree.id, note: ree.name });
          const [row] = await tx
            .insert(schema.message)
            .values({
              conversationId: conversation.id,
              role: 'ree',
              reeId: ree.id,
              content: streamed,
              citations,
              requestId: held.askedId,
              costCredits: settled?.charged ?? 0,
            })
            .returning({ id: schema.message.id, cost: schema.message.costCredits });
          await tx.update(schema.conversation).set({ updatedAt: new Date() }).where(eq(schema.conversation.id, conversation.id));
          return row!;
        });
        write({ type: 'data-outcome', data: outcome({ messageId: reply.id, cost: reply.cost, citations, model }) });
        write({ type: 'finish' });
      } catch (error) {
        console.warn(`answer ree=${ree.id} failed: ${error instanceof Error ? error.message : 'unknown'}`);
        await database.transaction((tx) => releaseHold(tx, held.holdId, { reeId: ree.id, note: ree.name })).catch(() => undefined);
        if (textOpen) write({ type: 'text-end', id: 'answer' });
        write({ type: 'data-outcome', data: outcome({ failed: true, model }) });
        write({ type: 'finish' });
      }
    },
    onError: () => 'answer_failed',
  });
  return createUIMessageStreamResponse({ stream });
}
