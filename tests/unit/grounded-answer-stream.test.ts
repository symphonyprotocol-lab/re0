/**
 * How a streamed Ree answer settles when the model stops at the output limit
 * (2026-11-24): a reasoning model that spends the whole budget thinking and
 * writes no text has failed, not declined; a sentinel or a real answer
 * settles as before.
 */
import { describe, expect, it, vi } from 'vitest';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

vi.mock('@/lib/infra/db', () => ({ db: () => { throw new Error('no database in this test'); }, schema: {} }));

const { OutputLimitBeforeText, streamGroundedAnswer } = await import('@/lib/services/grounded-answer');

type Part = Record<string, unknown> & { type: string };

const usage = (output: number, reasoning: number) => ({
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: output - reasoning, reasoning },
});

function modelWith(parts: Part[]) {
  return new MockLanguageModelV4({
    modelId: 'zai/glm-5.3-flash',
    doStream: async () => ({ stream: simulateReadableStream({ chunks: parts as never[] }) }),
  });
}

const reasoning = (text: string): Part[] => [
  { type: 'reasoning-start', id: 'r' },
  { type: 'reasoning-delta', id: 'r', delta: text },
  { type: 'reasoning-end', id: 'r' },
];
const text = (value: string): Part[] => [
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: value },
  { type: 'text-end', id: 't' },
];
const finish = (unified: 'stop' | 'length', output: number, thought: number): Part => ({
  type: 'finish',
  finishReason: { unified, raw: unified },
  usage: usage(output, thought),
});

function ask(parts: Part[]) {
  const generation = { model: modelWith(parts), endpoint: { model: 'zai/glm-5.3-flash', timeoutMs: 30_000 } } as never;
  return streamGroundedAnswer(
    {
      generation,
      ree: { id: 'ree-1', name: 'Temperance Crusade Assistant', systemPrompt: '' },
      lang: 'en',
      subject: 'How did the crusade begin in Ohio?',
      passages: [{ chunkId: 'c1', knowledgeId: 'k1', title: 'History', kind: 'document', content: 'Hillsboro, Ohio, December 1873.', locator: { page: 1 }, similarity: 0.7 }],
      turns: [],
    },
    () => undefined,
  );
}

describe('streamGroundedAnswer at the output limit', () => {
  it('fails when the reasoning used the whole budget and no text was written', async () => {
    await expect(ask([{ type: 'stream-start', warnings: [] }, ...reasoning('Let me think about the passages...'), finish('length', 1500, 1500)])).rejects.toBeInstanceOf(OutputLimitBeforeText);
  });

  it('still settles a sentinel as no answer', async () => {
    const result = await ask([{ type: 'stream-start', warnings: [] }, ...reasoning('Nothing here.'), ...text('[[NO_ANSWER]]'), finish('stop', 30, 20)]);
    expect(result.declined).toBe(true);
  });

  it('keeps an answer that was written, even when it reached the limit', async () => {
    const answer = 'The crusade began in Hillsboro, Ohio, in December 1873, when women marched to the saloons to pray and sing hymns until the keepers closed [1].';
    const result = await ask([{ type: 'stream-start', warnings: [] }, ...reasoning('The first passage says...'), ...text(answer), finish('length', 1500, 1400)]);
    expect(result.declined).toBe(false);
    expect(result.text).toBe(answer);
  });

  it('keeps a long reply that ends on the sentinel as an answer, saying it ended there', async () => {
    const refusal = 'The passages describe the temperance movement in general terms and name several towns, but none of them says how or where the crusade began in Ohio, so this cannot be answered from them.';
    const result = await ask([{ type: 'stream-start', warnings: [] }, ...text(`${refusal} [[NO_ANSWER]]`), finish('stop', 60, 0)]);
    expect(result).toMatchObject({ declined: false, endedOnSentinel: true });
    expect(result.text.trim()).toBe(refusal);
  });

  it('answers as before when the model stops on its own', async () => {
    const answer = 'It began at Hillsboro, Ohio, after Dio Lewis lectured there in December 1873 and the women marched to the saloons the next morning [1].';
    const result = await ask([{ type: 'stream-start', warnings: [] }, ...text(answer), finish('stop', 60, 0)]);
    expect(result).toMatchObject({ declined: false, endedOnSentinel: false, text: answer });
  });
});
