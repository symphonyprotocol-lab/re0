/**
 * The browser's reading of a synthesis stream (lib/client/conversations.ts):
 * the part as it grows, the finished part last, and a refusal before the
 * stream as an ApiError with its body. The stream is the one the server
 * writes, built with the same AI SDK helpers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { SYNTHESIS_PART_ID, type ReeUIMessage, type SynthesisPart } from '@/lib/domain/chat-message';
import { ApiError, streamSynthesis } from '@/lib/client/conversations';

const base = { synthesisId: 's1', requestId: 'q1', reeIds: ['r1', 'r2'], vote: null, sources: [], cost: 0 } satisfies Omit<SynthesisPart, 'state' | 'content'>;

function respondWith(response: Response) {
  vi.stubGlobal('fetch', vi.fn(async () => response));
}

afterEach(() => vi.unstubAllGlobals());

describe('streamSynthesis', () => {
  it('hands over the text as it streams, then the finished part', async () => {
    const stream = createUIMessageStream<ReeUIMessage>({
      execute: ({ writer }) => {
        writer.write({ type: 'start', messageId: 'q1-synthesis' });
        writer.write({ type: 'data-synthesis', id: SYNTHESIS_PART_ID, data: { ...base, state: 'streaming', content: '' } });
        writer.write({ type: 'text-start', id: 'synthesis-text' });
        writer.write({ type: 'text-delta', id: 'synthesis-text', delta: '## 结论\n' });
        writer.write({ type: 'text-delta', id: 'synthesis-text', delta: '- 14 天 [A1] [9]' });
        writer.write({ type: 'text-end', id: 'synthesis-text' });
        writer.write({ type: 'data-synthesis', id: SYNTHESIS_PART_ID, data: { ...base, state: 'done', content: '## 结论\n- 14 天 [A1]', cost: 30 } });
        writer.write({ type: 'finish' });
      },
    });
    respondWith(createUIMessageStreamResponse({ stream }));
    const seen: SynthesisPart[] = [];
    const done = await streamSynthesis('c1', 'q1', (part) => seen.push(part));
    expect(done).toMatchObject({ state: 'done', content: '## 结论\n- 14 天 [A1]', cost: 30 });
    const streamed = seen.filter((part) => part.state === 'streaming').map((part) => part.content);
    expect(streamed[0]).toBe('');
    expect(streamed.at(-1)).toBe('## 结论\n- 14 天 [A1] [9]');
    expect(seen.at(-1)).toEqual(done);
  });

  it('answers a failed part as it is, and a stream that never finished as an error', async () => {
    const failed = createUIMessageStream<ReeUIMessage>({
      execute: ({ writer }) => {
        writer.write({ type: 'data-synthesis', id: SYNTHESIS_PART_ID, data: { ...base, state: 'streaming', content: '' } });
        writer.write({ type: 'data-synthesis', id: SYNTHESIS_PART_ID, data: { ...base, synthesisId: null, state: 'failed', content: '' } });
      },
    });
    respondWith(createUIMessageStreamResponse({ stream: failed }));
    expect(await streamSynthesis('c1', 'q1', () => undefined)).toMatchObject({ state: 'failed' });

    const cut = createUIMessageStream<ReeUIMessage>({
      execute: ({ writer }) => writer.write({ type: 'data-synthesis', id: SYNTHESIS_PART_ID, data: { ...base, state: 'streaming', content: '' } }),
    });
    respondWith(createUIMessageStreamResponse({ stream: cut }));
    await expect(streamSynthesis('c1', 'q1', () => undefined)).rejects.toMatchObject({ code: 'synthesis_failed' });
  });

  it('throws a refusal with its body', async () => {
    respondWith(Response.json({ error: 'insufficient_credits', balance: 5, needed: 30 }, { status: 402 }));
    const error = await streamSynthesis('c1', 'q1', () => undefined).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'insufficient_credits', status: 402, body: { balance: 5, needed: 30 } });
  });
});
