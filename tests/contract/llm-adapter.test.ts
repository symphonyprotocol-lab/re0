/**
 * What the playground's model adapter does with time. architecture.md 9.5.
 *
 * The provider is a fake OpenAI-compatible endpoint behind `fetch`, answering
 * in server-sent events at whatever pace the test dictates. What is under
 * test is the shape of the timeout: idle time, re-armed by output, rather
 * than a total -- a slow provider that then answers must get through, and a
 * provider that goes quiet must not hold the reader past the limit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { llmAdapter } from '@/lib/infrastructure/ai/llm';
import { ProviderUnavailable } from '@/lib/infrastructure/ai/providers';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The adapter is handed an opened credential; nothing here reads an env. */
const CONFIG = { baseUrl: 'https://llm.example.test/v1', model: 'fixture', apiKey: 'test-key' };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function chunk(content: string, finish: 'stop' | null = null): string {
  return `data: ${JSON.stringify({
    id: 'c',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fixture',
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  })}\n\n`;
}

/** An endpoint that emits `pieces` with `gapMs` of silence before each one. */
function serveCompletion(pieces: string[], gapMs: number, options: { hang?: boolean } = {}) {
  globalThis.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    const encoder = new TextEncoder();
    const signal = init?.signal ?? null;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        /* A real fetch tears the body down when its signal aborts; the fake
           has to as well, or an abort would test nothing. */
        signal?.addEventListener('abort', () =>
          controller.error(new DOMException('The operation was aborted', 'AbortError')),
        );
        for (const piece of pieces) {
          await sleep(gapMs);
          if (signal?.aborted) return;
          controller.enqueue(encoder.encode(chunk(piece)));
        }
        if (options.hang) return; // never finishes, never closes
        controller.enqueue(encoder.encode(chunk('', 'stop')));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

async function collect(timeoutMs: number): Promise<string[]> {
  const stream = llmAdapter(CONFIG).stream({
    systemPrompt: 'system',
    userMessage: 'user',
    maxOutputTokens: 100,
    timeoutMs,
  });
  const out: string[] = [];
  for await (const delta of stream.textStream) out.push(delta);
  return out;
}

describe('the idle timeout', () => {
  it('lets a slow answer through as long as tokens keep coming', async () => {
    // Four pauses of 120 ms is 480 ms in total, past a 200 ms limit that
    // resets on every token. A total deadline would have cut this off.
    serveCompletion(['one ', 'two ', 'three ', 'four'], 120);
    await expect(collect(200)).resolves.toEqual(['one ', 'two ', 'three ', 'four']);
  });

  it('gives up on a provider that never starts', async () => {
    serveCompletion([], 10_000, { hang: true });
    const started = Date.now();
    await expect(collect(200)).rejects.toBeInstanceOf(ProviderUnavailable);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('gives up on a provider that goes quiet mid-answer, keeping what came', async () => {
    serveCompletion(['first '], 10, { hang: true });
    const stream = llmAdapter(CONFIG).stream({
      systemPrompt: 'system',
      userMessage: 'user',
      maxOutputTokens: 100,
      timeoutMs: 200,
    });
    const out: string[] = [];
    let failure: unknown = null;
    try {
      for await (const delta of stream.textStream) out.push(delta);
    } catch (error) {
      failure = error;
    }
    expect(out).toEqual(['first ']);
    expect(failure).toBeInstanceOf(ProviderUnavailable);
    expect((failure as Error).message).toContain('no output for 200 ms');
  });

  it('never rejects the usage promise, even when the stream failed', async () => {
    serveCompletion([], 10_000, { hang: true });
    const stream = llmAdapter(CONFIG).stream({
      systemPrompt: 'system',
      userMessage: 'user',
      maxOutputTokens: 100,
      timeoutMs: 100,
    });
    await expect((async () => { for await (const _ of stream.textStream) void _; })()).rejects.toBeInstanceOf(ProviderUnavailable);
    await expect(stream.usage).resolves.toMatchObject({ promptTokens: 0, completionTokens: 0 });
  });
});
