import { describe, expect, it } from 'vitest';
import { probeModelConfig } from '@/lib/application/administration/probe-model-config';

const embedding = {
  kind: 'embedding' as const,
  baseUrl: 'https://embed.example.test/v1',
  model: 'fixture-embed',
  apiKey: 'sk-fixture',
  dimensions: 4,
  timeoutMs: 5_000,
};
const rerank = { ...embedding, kind: 'rerank' as const, model: 'fixture-rerank', dimensions: null };

function adapters(options: {
  vectors?: number[][];
  scores?: number[];
  embedFails?: Error;
  rerankFails?: Error;
}) {
  const calls: { kind: string; config: unknown; args: unknown[] }[] = [];
  return {
    calls,
    embedding: (config: unknown) => ({
      model: 'fixture-embed',
      dimensions: 4,
      async embed(texts: string[]) {
        calls.push({ kind: 'embedding', config, args: [texts] });
        if (options.embedFails) throw options.embedFails;
        return options.vectors ?? [[0.1, 0.2, 0.3, 0.4]];
      },
    }),
    rerank: (config: unknown) => ({
      async rerank(query: string, candidates: string[]) {
        calls.push({ kind: 'rerank', config, args: [query, candidates] });
        if (options.rerankFails) throw options.rerankFails;
        return options.scores ?? [0.98, 0.01];
      },
    }),
  };
}

describe('retrieval model probe', () => {
  it('embeds one word with the width as typed and reports it', async () => {
    const deps = adapters({});
    const result = await probeModelConfig(embedding, deps);
    expect(result).toMatchObject({ ok: true, detail: '4 d', error: null });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(deps.calls[0]).toMatchObject({
      kind: 'embedding',
      config: { baseUrl: embedding.baseUrl, model: 'fixture-embed', dimensions: 4, timeoutMs: 5_000 },
      args: [['ping']],
    });
  });

  it('scores two passages and reports the scores', async () => {
    const deps = adapters({});
    const result = await probeModelConfig(rerank, deps);
    expect(result).toMatchObject({ ok: true, detail: '0.98 / 0.01', error: null });
    expect(deps.calls[0]).toMatchObject({ kind: 'rerank', config: { model: 'fixture-rerank' } });
    expect((deps.calls[0]!.args[1] as string[]).length).toBe(2);
  });

  it('names the failure when the adapter throws', async () => {
    expect(
      await probeModelConfig(embedding, adapters({ embedFails: new Error('embedding provider rejected: 401') })),
    ).toMatchObject({ ok: false, detail: null, error: 'embedding provider rejected: 401' });
    expect(
      await probeModelConfig(rerank, adapters({ rerankFails: new Error('provider answered 404') })),
    ).toMatchObject({ ok: false, error: 'provider answered 404' });
  });

  it('treats an empty vector or all-zero scores as not answering', async () => {
    expect((await probeModelConfig(embedding, adapters({ vectors: [[0, 0, 0, 0]] }))).error).toBe(
      'the provider returned an empty vector',
    );
    expect((await probeModelConfig(rerank, adapters({ scores: [0, 0] }))).error).toBe(
      'the provider returned no scores',
    );
  });

  it('refuses before any call without a credential or, for an embedding, a width', async () => {
    const deps = adapters({});
    expect((await probeModelConfig({ ...embedding, apiKey: '' }, deps)).error).toBe(
      'the model entry has no credential',
    );
    expect((await probeModelConfig({ ...embedding, dimensions: null }, deps)).error).toBe(
      'an embedding model needs a width',
    );
    expect(deps.calls).toHaveLength(0);
  });
});
