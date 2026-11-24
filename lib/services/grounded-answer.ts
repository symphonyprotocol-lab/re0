/**
 * One Ree's grounded answer (rebuild-proposal.md 5; 7, "问答生成"), shared by
 * public posts, their follow-ups, private posts, 试问 and MCP: which asked
 * Rees have knowledge to answer from, what one answer can cost, and the
 * answer itself, streamed from the retrieved passages under the Ree's
 * persona. Holds, settlement and storage belong to the callers (posts.ts,
 * private-posts.ts). Usage tokens go to the log only; users pay fixed
 * credits (7, "计费对接").
 */
import { streamText } from 'ai';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { ANSWER_STREAM_TIMEOUT_MAX_MS, NO_ANSWER_REFUSAL_CHARS, QUERY_BASE_FEE } from '@/lib/constants';
import { instructionsFor, NO_ANSWER_SENTINEL, questionWithPassages, sentinelState, settlesAsNoAnswer, withoutSentinel, type Passage } from '@/lib/domain/answer';
import { db, schema } from '@/lib/infra/db';
import type { generationForUser } from '@/lib/services/generation';
import type { Ree } from '@/lib/services/rees';
import { imagesNote } from '@/lib/domain/post-images';
import { visionOptions, withImages, type ImagePart } from '@/lib/services/post-images';

const MAX_OUTPUT_TOKENS = 1_500;

/** The most a question to this Ree can cost this user: the base fee, plus the query fee when it is not theirs. */
export function maxCostFor(ree: Pick<Ree, 'ownerId' | 'queryFee'>, userId: string): number {
  return QUERY_BASE_FEE + feeFor(ree, userId);
}

function feeFor(ree: Pick<Ree, 'ownerId' | 'queryFee'>, userId: string): number {
  return ree.ownerId === userId ? 0 : ree.queryFee;
}

/** Rees among these with at least one source answers may use. */
export async function readyRees(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db()
    .selectDistinct({ reeId: schema.knowledge.reeId })
    .from(schema.knowledge)
    .where(and(inArray(schema.knowledge.reeId, [...ids]), eq(schema.knowledge.status, 'ready'), eq(schema.knowledge.enabled, true), isNull(schema.knowledge.deletedAt)));
  return new Set(rows.map((row) => row.reeId));
}

/** A reply that reached the output limit before any text (a reasoning model's thinking took it all): the answer failed. */
export class OutputLimitBeforeText extends Error {
  constructor(model: string) {
    super(`output limit reached before any text (model=${model})`);
    this.name = 'OutputLimitBeforeText';
  }
}

/** What an answer reports while it is written: its text, as it streams (MCP's progress). */
export type AnswerEvent =
  | { type: 'text-start'; reeId: string }
  | { type: 'text-delta'; reeId: string; delta: string }
  | { type: 'text-end'; reeId: string };
export type Emit = (event: AnswerEvent) => void;

type Generation = Awaited<ReturnType<typeof generationForUser>>;

/**
 * One Ree's grounded answer, streamed through `emit` as it is written: the
 * text part opens only once the reply is known not to be the no-answer
 * sentinel, and a sentinel written after the answer began is dropped.
 * Answers whether the model declined (the sentinel, or a refusal-length
 * reply) and the text shown. A provider error, abort or timeout throws,
 * after closing the text part it opened.
 */
export async function streamGroundedAnswer(
  args: { generation: Generation; ree: Pick<Ree, 'id' | 'name' | 'systemPrompt'>; lang: 'zh' | 'en'; subject: string; passages: readonly Passage[]; turns: { role: 'user' | 'assistant'; content: string }[]; images?: readonly ImagePart[] },
  emit: Emit,
): Promise<{ declined: boolean; text: string; model: string }> {
  const { generation, ree, subject, passages, turns, images = [] } = args;
  const model = generation.endpoint.model;
  let textOpen = false;
  try {
    const result = streamText({
      model: generation.model,
      instructions: instructionsFor({ reeName: ree.name, systemPrompt: ree.systemPrompt, lang: args.lang }),
      /* A post's images come after the passages and the question; the model reads them as part of the question. */
      messages: [withImages(images.length ? `${questionWithPassages(subject, passages, turns)}\n\n${imagesNote(images.length)}` : questionWithPassages(subject, passages, turns), images)],
      ...visionOptions(images),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: 0.2,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(Math.min(Math.max(generation.endpoint.timeoutMs, 30_000) * 2, ANSWER_STREAM_TIMEOUT_MAX_MS)),
    });
    let decided: boolean | null = null;
    let finishReason: string | null = null;
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
    /*
     * The full stream, not `textStream`: that one drops `error` and `abort`
     * parts and ends as if the model had finished, so a reply cut off by a
     * provider error or the timeout would be charged as a whole answer
     * (review M6). Either one fails this Ree: its holds are released.
     */
    for await (const part of result.stream) {
      if (part.type === 'error') throw part.error instanceof Error ? part.error : new Error(`stream error: ${String(part.error)}`);
      if (part.type === 'abort') throw new Error(`stream aborted${part.reason ? `: ${part.reason}` : ''}`);
      if (part.type === 'finish' && part.finishReason === 'error') throw new Error('stream finished with an error');
      if (part.type === 'finish') finishReason = part.finishReason;
      if (part.type !== 'text-delta') continue;
      const delta = part.text;
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
    /* The entry that answered: a backup when the primary failed before writing (lib/infra/ai/failover.ts). */
    const answered = await Promise.resolve(result.response).then((response) => response.modelId || model, () => model);
    void Promise.resolve(result.usage).then(
      (usage) => console.info(`answer usage ree=${ree.id} model=${answered} in=${usage.inputTokens ?? 0} out=${usage.outputTokens ?? 0} reasoning=${usage.outputTokenDetails?.reasoningTokens ?? 0} finish=${finishReason ?? 'unknown'}`),
      () => undefined,
    );
    /*
     * Cut off at the output limit before it wrote a word: a reasoning model
     * (the generation list's backup, zai/glm-5.3-flash) can spend the whole
     * budget thinking. That is a failure, never the Ree declining: it was
     * read as no answer, unlogged, and the mentioned Ree silently missing
     * (2026-11-24, while agnes cooled down after 429s).
     */
    if (finishReason === 'length' && decided !== true && !raw.trim()) throw new OutputLimitBeforeText(answered);
    return { declined: decided === true || settlesAsNoAnswer(raw, streamed, NO_ANSWER_REFUSAL_CHARS), text: streamed, model: answered };
  } catch (error) {
    if (textOpen) emit({ type: 'text-end', reeId: ree.id });
    throw error;
  }
}
