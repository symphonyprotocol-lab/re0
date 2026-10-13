/**
 * The playground's LLM adapter. architecture.md 9.5.
 *
 * Its own module, not part of `providers.ts`, because that file is on the
 * REST and MCP request path and 9.5 requires those to keep working with the
 * generation layer removed. Only the playground and the console's endpoint
 * probe import this, so nothing on the retrieval path pulls in the AI SDK.
 *
 * Nothing here returns an AI SDK type either -- §20 forbids a provider type
 * reaching the domain or the SDK, so deltas come back as strings and token
 * counts as numbers.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';
import { openThinkFilter, TIMEOUT_MS } from '@/lib/domain/generation';
import { ProviderUnavailable } from './providers';

/** What one streamed completion hands back. No provider types, by design. */
export interface LlmStream {
  /** Text deltas in order. Throws `ProviderUnavailable` if the call fails. */
  textStream: AsyncIterable<string>;
  /**
   * Token counts for the cost metric, the only place they go.
   *
   * `cachedTokens` is the share of `promptTokens` the provider served from
   * cache, and `reasoningTokens` the share of `completionTokens` spent
   * thinking -- both breakdowns of the totals beside them, never additions.
   *
   * Deliberately never rejects: a failed call surfaces once, through
   * `textStream`, and a second rejecting promise nobody is awaiting yet is an
   * unhandled rejection that takes the process with it.
   */
  usage: Promise<{
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
  }>;
}

export interface LlmAdapter {
  /**
   * One completion, streamed. The prompt arrives assembled -- the system
   * prompt separate from the user message that carries the untrusted excerpts
   * -- and the caller owns parsing and citation binding (architecture.md 9.5).
   */
  stream(input: {
    systemPrompt: string;
    userMessage: string;
    maxOutputTokens: number;
    timeoutMs: number;
    /** Only for a model configured as a reasoning one; omitted otherwise. */
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | null;
  }): LlmStream;
}

/**
 * OpenAI-compatible chat completions, through the AI SDK.
 *
 * Endpoint, model and credential are all configuration the console owns
 * (`llm_config`); the key arrives already opened, so this module never touches
 * the cipher or the secret that opens it (architecture.md 15.3). One attempt,
 * no retries: 9.5 degrades to the chunk list rather than spending the budget
 * on a provider that is not answering, so the SDK's own retrying is switched
 * off.
 *
 * Two clocks, not one. `timeoutMs` is idle time: it runs from the request
 * until the first token and is re-armed by every token after, so it catches
 * a provider that never starts or stops mid-answer -- the two ways "not
 * answering" actually looks. A single total deadline was the wrong shape:
 * it cut a slow prefill followed by a good answer at exactly the moment it
 * cut a dead provider, and the reader saw the same empty list for both. The
 * total is still bounded, by the largest timeout the console allows, as a
 * guard against a stream that never ends rather than as a budget.
 *
 * Reasoning deltas re-arm the idle clock too. A model that is thinking is
 * producing output the reader never sees, and treating that as silence would
 * time out every reasoning model on every question worth asking it.
 */
const PROVIDER_NAME = 'llm';

/** The hard end of any one call, however busy the model still is. */
const STREAM_CEILING_MS = TIMEOUT_MS.max;

export function llmAdapter(config: { baseUrl: string; model: string; apiKey: string }): LlmAdapter {
  /* Refused here as well as at the call site: an entry saved before it had a
     credential resolves to an empty string, and an empty Bearer token reaches
     the provider as a puzzling 401 rather than as the configuration gap it is. */
  const apiKey = config.apiKey;
  if (!apiKey) throw new ProviderUnavailable('llm', 'the model entry has no credential');

  const provider = createOpenAICompatible({
    name: PROVIDER_NAME,
    baseURL: config.baseUrl.replace(/\/+$/, ''),
    apiKey,
    /* Without this an OpenAI-compatible stream omits the usage chunk, and the
       cost metric silently records every call as zero tokens. */
    includeUsage: true,
  });

  return {
    stream(input) {
      const clock = deadlines(input.timeoutMs);

      const result = streamText({
        model: provider.chatModel(config.model),
        system: input.systemPrompt,
        prompt: input.userMessage,
        maxOutputTokens: input.maxOutputTokens,
        temperature: 0,
        maxRetries: 0,
        abortSignal: clock.signal,
        /* Keyed by the provider name above; an endpoint that does not know the
           field ignores it, which is why nothing here depends on the answer. */
        ...(input.reasoningEffort
          ? { providerOptions: { [PROVIDER_NAME]: { reasoningEffort: input.reasoningEffort } } }
          : {}),
      });

      return {
        textStream: (async function* deltas(): AsyncGenerator<string> {
          /* A gateway that serves thinking inline as `<think>…</think>` text
             would otherwise hand the reader the model's scratch work. */
          const thinking = openThinkFilter();
          try {
            /*
             * The full stream rather than `textStream`: reasoning deltas are
             * only visible here, and so are the SDK's error and abort parts,
             * which it reports in-band instead of throwing.
             */
            for await (const part of result.fullStream) {
              if (part.type === 'text-delta') {
                clock.touch();
                const text = thinking.push(part.text);
                if (text.length > 0) yield text;
              } else if (part.type === 'reasoning-delta') {
                clock.touch();
              } else if (part.type === 'error') {
                throw part.error;
              } else if (part.type === 'abort') {
                throw new Error('aborted');
              }
            }
            const tail = thinking.flush();
            if (tail.length > 0) yield tail;
          } catch (error) {
            /* The SDK's error classes are provider detail; the seam converts
               them to the one failure the application knows how to degrade
               from. A timeout names itself, so the operator's log says which
               clock ran out rather than the SDK's generic abort message. */
            throw new ProviderUnavailable(
              'llm',
              clock.expired ?? (error instanceof Error ? error.message : 'stream failed'),
            );
          } finally {
            clock.stop();
          }
        })(),
        usage: Promise.resolve(result.usage).then(
          (usage) => ({
            promptTokens: usage.inputTokens ?? 0,
            completionTokens: usage.outputTokens ?? 0,
            cachedTokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
            reasoningTokens: usage.outputTokenDetails.reasoningTokens ?? 0,
          }),
          () => ({ promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0 }),
        ),
      };
    },
  };
}

/**
 * The idle clock and the ceiling, sharing one abort signal.
 *
 * `touch` re-arms the idle clock; `stop` clears both, and runs from the
 * generator's `finally` so a consumer that stops reading early does not leave
 * a timer holding the process open. `expired` says which clock fired, for the
 * failure message, and stays null when the abort came from anywhere else.
 */
function deadlines(idleMs: number): {
  signal: AbortSignal;
  expired: string | null;
  touch(): void;
  stop(): void;
} {
  const controller = new AbortController();
  let idle: ReturnType<typeof setTimeout> | undefined;

  const clock = {
    signal: controller.signal,
    expired: null as string | null,
    touch(): void {
      clearTimeout(idle);
      idle = setTimeout(() => expire(`no output for ${idleMs} ms`), idleMs);
    },
    stop(): void {
      clearTimeout(idle);
      clearTimeout(ceiling);
    },
  };

  function expire(reason: string): void {
    clock.expired ??= reason;
    controller.abort();
  }

  const ceiling = setTimeout(
    () => expire(`still streaming after ${STREAM_CEILING_MS} ms`),
    STREAM_CEILING_MS,
  );
  clock.touch();
  return clock;
}
