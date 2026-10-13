/**
 * The console's endpoint probe: reachable means the model answered with
 * text; every other outcome names why, and nothing about the call is
 * recorded anywhere.
 */
import { describe, expect, it } from 'vitest';
import { probeLlmConfig } from '@/lib/application/administration/probe-llm-config';

const input = {
  baseUrl: 'https://llm.example.test/v1',
  model: 'fixture',
  apiKey: 'sk-fixture',
  timeoutMs: 5_000,
  reasoningEffort: null,
};

function adapterReplying(deltas: string[], fail?: Error) {
  const calls: unknown[] = [];
  return {
    calls,
    llm: () => ({
      stream(request: unknown) {
        calls.push(request);
        return {
          textStream: (async function* () {
            if (fail) throw fail;
            for (const delta of deltas) yield delta;
          })(),
          usage: Promise.resolve({
            promptTokens: 12,
            completionTokens: 2,
            cachedTokens: 0,
            reasoningTokens: 0,
          }),
        };
      },
    }),
  };
}

describe('llm endpoint probe', () => {
  it('reports a reachable model with its reply, latency and tokens', async () => {
    const deps = adapterReplying(['O', 'K\n']);
    const result = await probeLlmConfig(input, deps);
    expect(result).toMatchObject({ ok: true, reply: 'OK', promptTokens: 12, completionTokens: 2, error: null });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    /* The playground's own settings ride along, so what passes here passes there. */
    expect(deps.calls[0]).toMatchObject({ timeoutMs: 5_000, reasoningEffort: null, maxOutputTokens: 32 });
  });

  it('names the failure when the provider refuses or the stream breaks', async () => {
    const result = await probeLlmConfig(input, adapterReplying([], new Error('401 invalid api key')));
    expect(result).toMatchObject({ ok: false, reply: null, error: '401 invalid api key' });
  });

  it('treats an empty reply as unreachable, and a missing key as a failure before any call', async () => {
    expect((await probeLlmConfig(input, adapterReplying(['  ']))).error).toBe('the model returned no text');
    /* An entry whose credential could not be opened arrives here as an empty
       one, and must not become an outbound call carrying no Bearer token. */
    const deps = adapterReplying(['OK']);
    const result = await probeLlmConfig({ ...input, apiKey: '' }, deps);
    expect(result).toMatchObject({ ok: false, error: 'the model entry has no credential' });
    expect(deps.calls).toHaveLength(0);
  });
});
