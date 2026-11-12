/**
 * A question rewritten into the language of the knowledge it is asked of
 * (lib/domain/cross-lingual.ts), for retrieval only: the answer still sees
 * the question as asked. One generation call and one embedding per target
 * language per question, shared by every Ree asked in it, and only for the
 * Rees whose recall showed knowledge in another language.
 *
 * The call is logged as `retrieval` with the asker and metered like every
 * provider call; it is the platform's cost inside the base fee, never
 * charged on its own. Any failure leaves the question searched as asked.
 */
import { generateText, Output } from 'ai';
import { REWRITE_OUTPUT_TOKENS, REWRITE_TIMEOUT_MS } from '@/lib/constants';
import { REWRITE_SCHEMA, rewriteInstructions, rewriteOf, rewritePrompt, rewriteTerms, type Script } from '@/lib/domain/cross-lingual';
import { embedQuestion, type QuestionVector } from '@/lib/services/chat';
import { generationForUser } from '@/lib/services/generation';

export interface QuestionRewrite {
  target: Script;
  query: string;
  /** Keyword-search terms from the query and the model's keywords. */
  terms: string[];
  /** The query's vector, or null when the model gave keywords only. */
  vector: QuestionVector | null;
}

/** The question's rewrite into `target`'s language, or null when there is none to search. */
export type Rewriter = (target: Script) => Promise<QuestionRewrite | null>;

/** A rewriter for one question, asked by `userId`: each target language is rewritten once, however many Rees want it. */
export function questionRewriter(userId: string, question: string): Rewriter {
  const made = new Map<Script, Promise<QuestionRewrite | null>>();
  return (target) => {
    let rewrite = made.get(target);
    if (!rewrite) {
      rewrite = rewriteQuestion(userId, question, target);
      made.set(target, rewrite);
    }
    return rewrite;
  };
}

async function rewriteQuestion(userId: string, question: string, target: Script): Promise<QuestionRewrite | null> {
  try {
    const generation = await generationForUser(userId, 'retrieval');
    const { output } = await generateText({
      model: generation.model,
      output: Output.object({ schema: REWRITE_SCHEMA }),
      instructions: rewriteInstructions(target),
      prompt: rewritePrompt(question),
      maxOutputTokens: REWRITE_OUTPUT_TOKENS,
      temperature: 0,
      /* A translation needs no deliberation; providers without the setting ignore it. */
      reasoning: 'minimal',
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(Math.min(generation.endpoint.timeoutMs, REWRITE_TIMEOUT_MS)),
    });
    const rewrite = rewriteOf(output);
    if (!rewrite) return null;
    const vector = rewrite.query ? await embedQuestion(rewrite.query) : null;
    return { target, query: rewrite.query, terms: rewriteTerms(rewrite), vector };
  } catch (error) {
    console.warn(`question rewrite target=${target} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return null;
  }
}
