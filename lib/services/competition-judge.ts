/**
 * The two model calls a Ree competition makes per answer
 * (docs/design/competitions.md 7.3, 8): the entrant Ree's answer, from its
 * knowledge as it stood at the deadline and under the system prompt it had
 * then, and the AI judge's grading of it against the reference. Both are
 * injectable (lib/services/competition-run.ts `RunDeps`), so tests need no
 * model.
 *
 * The answer is shown the question and its detail alone: the reference and
 * the rubric never reach it (7.1).
 */
import { generateText } from 'ai';
import { eq } from 'drizzle-orm';
import { citationSnapshots } from '@/lib/domain/answer';
import { COMPETITION_JUDGE_MAX_OUTPUT_TOKENS, COMPETITION_JUDGE_TIMEOUT_MS, judgeInstructions, judgePrompt, parseJudgeReply, type JudgeMaterial, type JudgeRun } from '@/lib/domain/competition';
import { modelFor } from '@/lib/infra/ai/models';
import { db, schema } from '@/lib/infra/db';
import { generationForUser } from '@/lib/services/generation';
import { streamGroundedAnswer } from '@/lib/services/grounded-answer';
import type { AnswerResult } from '@/lib/services/posts';
import { questionRewriter } from '@/lib/services/question-rewrite';
import { embedQuestion, retrieve, type QuestionVector } from '@/lib/services/retrieval';

export interface CompetitionAnswerInput {
  reeId: string;
  /** The question and its detail: everything the Ree is shown. */
  subject: string;
  lang: 'zh' | 'en';
  vector: QuestionVector | null;
  /** The deadline: only knowledge neither added nor changed since then. */
  asOf: Date;
  /** The Ree's system prompt at the deadline. */
  systemPrompt: string;
  signal: AbortSignal;
}

export type CompetitionAnswerer = (input: CompetitionAnswerInput) => Promise<AnswerResult>;

/** One entrant Ree's answer on the free tier's generation model (every entrant the same tier, 7.3), logged as `competition_answer`. */
export const modelCompetitionAnswer: CompetitionAnswerer = async ({ reeId, subject, lang, vector, asOf, systemPrompt, signal }) => {
  const [target] = await db().select({ id: schema.ree.id, name: schema.ree.name }).from(schema.ree).where(eq(schema.ree.id, reeId)).limit(1);
  if (!target) return { state: 'no_answer', model: null };
  let model: string | null = null;
  try {
    const found = await retrieve(reeId, subject, vector ?? (await embedQuestion(subject)), { rewrite: questionRewriter(null, subject), asOf });
    if (!found.evidence) return { state: 'no_answer', model: null };
    signal.throwIfAborted();
    const generation = await generationForUser(null, 'competition_answer');
    model = generation.endpoint.model;
    const { declined, text, model: answered } = await streamGroundedAnswer({ generation, ree: { id: target.id, name: target.name, systemPrompt }, lang, subject, passages: found.passages, turns: [] }, () => undefined);
    model = answered;
    if (declined || !text.trim()) return { state: 'no_answer', model };
    return { state: 'answered', text: text.trim(), citations: citationSnapshots(text, found.passages), model };
  } catch (error) {
    console.warn(`competition answer ree=${reeId} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { state: 'failed', model };
  }
};

/** One judge run; throws when the model fails or its reply has no scores (the runner retries). */
export type CompetitionJudge = (input: { material: JudgeMaterial; swapped: boolean; lang: 'zh' | 'en' }) => Promise<JudgeRun>;

/** The model the judge runs on: the plan tier's generation model (8.1), fixed per competition at the deadline. */
export async function judgeModelName(): Promise<string> {
  return (await modelFor('generation', 'plan', { purpose: 'competition_judge' })).endpoint.model;
}

/** The AI judge on the plan tier's generation model at temperature 0, its JSON read leniently (8.1). */
export const modelCompetitionJudge: CompetitionJudge = async ({ material, swapped, lang }) => {
  const generation = await modelFor('generation', 'plan', { purpose: 'competition_judge' });
  const { text, response } = await generateText({
    model: generation.model,
    instructions: judgeInstructions(lang),
    messages: [{ role: 'user', content: judgePrompt(material, swapped) }],
    maxOutputTokens: COMPETITION_JUDGE_MAX_OUTPUT_TOKENS,
    temperature: 0,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(COMPETITION_JUDGE_TIMEOUT_MS),
  });
  const parsed = parseJudgeReply(text);
  if (!parsed) throw new Error(`judge reply had no scores (chars=${text.length})`);
  return { ...parsed, model: response.modelId || generation.endpoint.model, swapped };
};
