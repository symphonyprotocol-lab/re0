/**
 * One minimal call against a model endpoint, for the console. architecture.md
 * 9.5: the playground is the model's only production caller, and an operator
 * saving an endpoint has no way to know it answers until a visitor tries it.
 * This is that try, made on purpose: the shortest prompt the adapter can
 * send, with the same idle clock and reasoning setting the playground would
 * use, so what passes here passes there.
 *
 * Takes the values as typed rather than a saved entry, so a configuration can
 * be checked before it is minted. Nothing is recorded: no cost event (there
 * is no library to bill it to) and no audit (nothing changed). The tokens
 * spent are returned so the operator sees what the check cost.
 */
import type { ReasoningEffort } from '@/lib/domain/generation';
import { llmAdapter, type LlmAdapter } from '@/lib/infrastructure/ai/llm';

export interface LlmProbeInput {
  baseUrl: string;
  model: string;
  /**
   * The credential to call with: the one typed into the form when the entry
   * is new, or the stored one opened for it. Never reaches the browser --
   * the action resolves it on the way in.
   */
  apiKey: string;
  timeoutMs: number;
  reasoningEffort: ReasoningEffort | null;
}

export interface LlmProbeResult {
  ok: boolean;
  latencyMs: number;
  /** The model's reply, trimmed to a line; null when the call failed. */
  reply: string | null;
  promptTokens: number;
  completionTokens: number;
  /** The provider's or the adapter's failure message; null on success. */
  error: string | null;
}

export interface LlmProbeDependencies {
  llm(config: { baseUrl: string; model: string; apiKey: string }): LlmAdapter;
}

const PROBE_SYSTEM_PROMPT = 'Reply with the single word OK.';
const PROBE_USER_MESSAGE = 'ping';
/** Enough for "OK" from a model that ignores instructions and explains itself. */
const PROBE_MAX_OUTPUT_TOKENS = 32;
const REPLY_CHARS = 120;

export async function probeLlmConfig(
  input: LlmProbeInput,
  dependencies: LlmProbeDependencies = { llm: llmAdapter },
): Promise<LlmProbeResult> {
  const startedAt = Date.now();
  const failed = (error: string): LlmProbeResult => ({
    ok: false,
    latencyMs: Date.now() - startedAt,
    reply: null,
    promptTokens: 0,
    completionTokens: 0,
    error,
  });

  if (input.apiKey.length === 0) return failed('the model entry has no credential');

  let stream;
  try {
    stream = dependencies
      .llm({ baseUrl: input.baseUrl, model: input.model, apiKey: input.apiKey })
      .stream({
      systemPrompt: PROBE_SYSTEM_PROMPT,
      userMessage: PROBE_USER_MESSAGE,
      maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
      timeoutMs: input.timeoutMs,
      reasoningEffort: input.reasoningEffort,
    });
  } catch (error) {
    return failed(error instanceof Error ? error.message : 'adapter unavailable');
  }

  let text = '';
  try {
    for await (const delta of stream.textStream) text += delta;
  } catch (error) {
    return failed(error instanceof Error ? error.message : 'stream failed');
  }

  const usage = await stream.usage;
  const reply = text.replace(/\s+/g, ' ').trim().slice(0, REPLY_CHARS);
  /* A stream that ended without a byte is a provider that accepted the call
     and said nothing -- reachable, but not answering. */
  if (reply.length === 0) return failed('the model returned no text');

  return {
    ok: true,
    latencyMs: Date.now() - startedAt,
    reply,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    error: null,
  };
}
