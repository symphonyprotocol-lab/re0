/**
 * Rewrite on miss, as a decision. architecture.md 9.5 and 9.6: when no
 * library confirms the question as asked, and only then, and only with a
 * usable model, the playground asks for one reformulation and reads again.
 * The miss released its seat, so the retry is metered: the exchange's one
 * Call is kept only if the retry finds context. A retry that confirms
 * answers from its chunks; one that misses, or a rewrite that fails, is the
 * same no-context as before.
 *
 * Everything below the playground is faked through its dependency seams, so
 * this runs without a database or a provider.
 */
import { describe, expect, it } from 'vitest';
import type { HistoryTurn } from '@/lib/domain/generation';
import type { GatherResult, GatheredChunk } from '@/lib/application/retrieval/gather';
import { streamPlayground, type PlaygroundDependencies, type PlaygroundEvent } from '@/lib/application/playground';
import { DEFAULT_RETRIEVAL_SETTINGS } from '@/lib/domain/retrieval-config';
import { REWRITE_LIMITS, REWRITE_SYSTEM_PROMPT } from '@/lib/domain/generation';

const CONFIG = {
  id: 'cfg_1',
  slug: 'fixture',
  label: 'Fixture model',
  baseUrl: 'https://llm.example.test/v1',
  model: 'fixture-llm-1',
  hasCredential: true,
  maxInputTokens: 8_000,
  maxOutputTokens: 800,
  timeoutMs: 15_000,
  promptPriceMicro: 3_000_000,
  completionPriceMicro: 15_000_000,
  cachePriceMicro: 300_000,
  supportsTools: false,
  supportsReasoning: false,
  supportsVision: false,
  reasoningEffort: null,
  enabled: true,
  createdAt: new Date(),
  assignedTo: ['trial' as const],
};

const LIBRARY = { libraryId: '/websites/apage', title: 'Apage' };
const caller = { workspaceId: null, apiKeyId: null, requestId: 'req_1', anonymous: true };

function chunk(id: string, text: string): GatheredChunk {
  return {
    chunkId: id,
    text,
    score: 0.5,
    tokens: 12,
    citation: { sourceUrl: 'https://apage.host/pricing', documentTitle: 'Pricing', section: null, lines: null },
    libraryId: LIBRARY.libraryId,
    libraryTitle: LIBRARY.title,
    version: 'v1',
  };
}

function gathered(confirmed: boolean): GatherResult {
  return {
    chunks: confirmed ? [chunk('c1', 'Subscribe to a plan on the pricing page.')] : [chunk('c0', 'Unrelated.')],
    libraries: [
      {
        ...LIBRARY,
        version: 'v1',
        confirmed,
        faqNearest: null,
        chunks: confirmed ? 1 : 0,
        failed: false,
        excerpts: ['Choose the plan that fits your sharing volume.'],
      },
    ],
    requestId: caller.requestId,
  };
}

interface Fixture {
  /** Confirmed-or-not, per gather, in call order. */
  passes: boolean[];
  /** What the model replies to the rewrite prompt; a thrown error fails the call. */
  rewriteReply?: string | Error;
  /** No usable model at all. */
  noModel?: boolean;
  /** The turns before the question, as a widget sends them. */
  history?: HistoryTurn[];
}

function fixture(options: Fixture) {
  const gathers: { query: string; meter: boolean }[] = [];
  const llmCalls: { system: string; user: string; maxOutputTokens: number; timeoutMs: number }[] = [];
  const costs: { promptTokens: number; completionTokens: number }[] = [];
  let pass = 0;

  const dependencies: PlaygroundDependencies = {
    config: async () => (options.noModel ? null : CONFIG),
    audience: async () => 'trial',
    credential: async () => 'sk-fixture',
    recordCost: async (input) => {
      costs.push({ promptTokens: input.promptTokens, completionTokens: input.completionTokens });
    },
    retrieval: {
      embeddings: () => {
        throw new Error('not used');
      },
      rerank: () => {
        throw new Error('not used');
      },
      cache: () => ({ get: async () => null, set: async () => {}, invalidateTag: async () => {} }),
      configured: () => ({ embeddings: false, rerank: false }),
      settings: async () => ({ ...DEFAULT_RETRIEVAL_SETTINGS, configId: null, createdAt: null }),
    },
    gather: async (_caller, input) => {
      gathers.push({ query: input.query, meter: input.meter !== false });
      const confirmed = options.passes[pass] ?? false;
      pass += 1;
      return gathered(confirmed);
    },
    hints: async () => [
      {
        libraryId: LIBRARY.libraryId,
        title: 'Apage',
        description: 'Static site hosting',
        language: 'en',
        documentTitles: ['Pricing', 'Plans'],
        terms: ['subscription', 'plan'],
        excerpts: [],
      },
    ],
    llm: () => ({
      stream(input) {
        llmCalls.push({
          system: input.systemPrompt,
          user: input.userMessage,
          maxOutputTokens: input.maxOutputTokens,
          timeoutMs: input.timeoutMs,
        });
        const rewriting = input.systemPrompt === REWRITE_SYSTEM_PROMPT;
        const reply = rewriting
          ? (options.rewriteReply ?? 'how to subscribe to a plan')
          : 'Subscribe to a plan on the pricing page. [ref:1]';
        return {
          textStream: (async function* deltas() {
            if (reply instanceof Error) throw reply;
            for (const piece of reply.match(/[\s\S]{1,5}/g) ?? []) yield piece;
          })(),
          usage: Promise.resolve({
            promptTokens: rewriting ? 80 : 400,
            completionTokens: rewriting ? 8 : 40,
            cachedTokens: 0,
            reasoningTokens: 0,
          }),
        };
      },
    }),
  };

  return { dependencies, gathers, llmCalls, costs };
}

async function run(options: Fixture) {
  const f = fixture(options);
  const events: PlaygroundEvent[] = [];
  for await (const event of streamPlayground(
    caller,
    { libraries: [LIBRARY], question: '会员怎么开通?', history: options.history },
    f.dependencies,
  )) {
    events.push(event);
  }
  return { ...f, events, types: events.map((event) => event.type) };
}

describe('playground rewrite on miss', () => {
  it('never rewrites a question that confirmed on the first pass', async () => {
    const { gathers, llmCalls, types } = await run({ passes: [true] });
    expect(gathers).toEqual([{ query: '会员怎么开通?', meter: true }]);
    /* One model call: the answer. */
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]!.system).not.toBe(REWRITE_SYSTEM_PROMPT);
    expect(types).not.toContain('rewrite');
    expect(types.at(-1)).toBe('done');
  });

  it('rewrites once on a miss and answers from the retry, charging one Call', async () => {
    const { gathers, llmCalls, costs, events, types } = await run({ passes: [false, true] });
    expect(gathers).toEqual([
      { query: '会员怎么开通?', meter: true },
      /* Metered: the miss gave its seat back (gather.ts), and only a retry with context keeps one. */
      { query: 'how to subscribe to a plan', meter: true },
    ]);
    /* The rewrite call is bounded by its output cap and the entry's own clock, and describes the site from its profile. */
    const rewrite = llmCalls[0]!;
    expect(rewrite.system).toBe(REWRITE_SYSTEM_PROMPT);
    expect(rewrite.maxOutputTokens).toBe(REWRITE_LIMITS.maxOutputTokens);
    expect(rewrite.timeoutMs).toBe(15_000);
    expect(rewrite.user).toContain('Static site hosting');
    expect(rewrite.user).toContain('subscription');
    /* The passages the missed retrieval came closest to travel with the hint. */
    expect(rewrite.user).toContain('passages: Choose the plan that fits your sharing volume.');
    expect(rewrite.user).toContain('Question: 会员怎么开通?');
    /* The answer still comes from the retry's chunks, bound as ever. */
    expect(types).toEqual(['model', 'gather', 'rewrite', 'gather', 'context', 'claim', 'done']);
    expect(events.find((event) => event.type === 'rewrite')).toEqual({
      type: 'rewrite',
      query: 'how to subscribe to a plan',
    });
    const context = events.find((event) => event.type === 'context');
    expect(context && context.type === 'context' ? context.chunks[0]!.chunkId : null).toBe('c1');
    expect(events.at(-1)).toMatchObject({ kind: 'answer' });
    /* Both calls land in the cost ledger. */
    expect(costs).toEqual([
      { promptTokens: 80, completionTokens: 8 },
      { promptTokens: 400, completionTokens: 40 },
    ]);
  });

  it('is the same no-context when the retry misses too', async () => {
    const { gathers, types, events, costs } = await run({ passes: [false, false] });
    expect(gathers).toHaveLength(2);
    expect(types).toEqual(['model', 'gather', 'context', 'done']);
    expect(events.at(-1)).toMatchObject({ kind: 'no_context' });
    /* The rewrite was spent and is recorded; nothing else was called. */
    expect(costs).toHaveLength(1);
  });

  it('falls through to no-context when the rewrite fails or says nothing useful', async () => {
    const failed = await run({ passes: [false, true], rewriteReply: new Error('provider down') });
    expect(failed.gathers).toHaveLength(1);
    expect(failed.events.at(-1)).toMatchObject({ kind: 'no_context' });
    expect(failed.costs).toHaveLength(0);

    const empty = await run({ passes: [false, true], rewriteReply: '   \n' });
    expect(empty.gathers).toHaveLength(1);
    expect(empty.events.at(-1)).toMatchObject({ kind: 'no_context' });

    const same = await run({ passes: [false, true], rewriteReply: '会员怎么开通?' });
    expect(same.gathers).toHaveLength(1);
    expect(same.events.at(-1)).toMatchObject({ kind: 'no_context' });
  });

  it('never runs without a usable model', async () => {
    const { gathers, llmCalls, types, events } = await run({ passes: [false, true], noModel: true });
    expect(gathers).toHaveLength(1);
    expect(llmCalls).toHaveLength(0);
    expect(types).toEqual(['gather', 'context', 'done']);
    expect(events.at(-1)).toMatchObject({ kind: 'no_context' });
  });
});

describe('direct FAQ answer', () => {
  it('answers from a FAQ chunk the question sits on, without the model', async () => {
    const { dependencies, llmCalls } = fixture({ passes: [true] });
    const faq: GatheredChunk = {
      ...chunk('faq1', 'Solo is $3 a month. Billed monthly.'),
      citation: { sourceUrl: 'https://apage.host/pricing', documentTitle: 'How much is Solo?', section: null, lines: null, kind: 'faq' },
    };
    dependencies.gather = async () => ({
      chunks: [faq, chunk('c1', 'Subscribe to a plan on the pricing page.')],
      libraries: [
        {
          ...LIBRARY,
          /* Named by an alias the caller used: the match is by chunk id, not library id. */
          libraryId: '/websites/apage-old',
          version: 'v1',
          confirmed: true,
          faqNearest: { chunkId: 'faq1', distance: 0.12 },
          chunks: 2,
          failed: false,
          excerpts: [],
        },
      ],
      requestId: caller.requestId,
    });
    const events = [];
    for await (const event of streamPlayground(caller, { libraries: [LIBRARY], question: 'how much is solo' }, dependencies)) {
      events.push(event);
    }
    expect(events.filter((event) => event.type === 'claim')).toEqual([
      { type: 'claim', claim: 'Solo is $3 a month.', chunkIds: ['faq1'] },
      { type: 'claim', claim: 'Billed monthly.', chunkIds: ['faq1'] },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'done', kind: 'answer' });
    expect(llmCalls).toHaveLength(0);
  });

  it('calls the model when the FAQ chunk is near but not the question asked', async () => {
    const { dependencies, llmCalls } = fixture({ passes: [true] });
    const faq: GatheredChunk = {
      ...chunk('faq1', 'Solo is $3 a month.'),
      citation: { sourceUrl: 'https://apage.host/pricing', documentTitle: 'How much is Solo?', section: null, lines: null, kind: 'faq' },
    };
    dependencies.gather = async () => ({
      chunks: [faq],
      libraries: [{ ...LIBRARY, version: 'v1', confirmed: true, faqNearest: { chunkId: 'faq1', distance: 0.45 }, chunks: 1, failed: false, excerpts: [] }],
      requestId: caller.requestId,
    });
    const events = [];
    for await (const event of streamPlayground(caller, { libraries: [LIBRARY], question: 'can I pay yearly for solo' }, dependencies)) {
      events.push(event);
    }
    expect(llmCalls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'done', kind: 'answer' });
  });
});

/**
 * A follow-up is not a call of its own: the question is tried as typed, and
 * the turns before it reach the model only inside the rewrite on a miss.
 */
describe('history', () => {
  const history: HistoryTurn[] = [{ question: 'What is the team plan?', answer: 'The team plan has 10 seats.' }];

  it('costs nothing when the question as typed confirms', async () => {
    const { gathers, llmCalls, types } = await run({ passes: [true], history });
    expect(gathers).toEqual([{ query: '会员怎么开通?', meter: true }]);
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]!.system).not.toBe(REWRITE_SYSTEM_PROMPT);
    expect(types).not.toContain('rewrite');
  });

  it('shows the turns to the one rewrite call on a miss', async () => {
    const { gathers, llmCalls, types } = await run({ passes: [false, true], history });
    expect(gathers.map((gather) => gather.query)).toEqual(['会员怎么开通?', 'how to subscribe to a plan']);
    const rewrites = llmCalls.filter((call) => call.system === REWRITE_SYSTEM_PROMPT);
    expect(rewrites).toHaveLength(1);
    expect(rewrites[0]!.user).toContain('<turn n="1">');
    expect(rewrites[0]!.user).toContain('A: The team plan has 10 seats.');
    expect(types).toEqual(['model', 'gather', 'rewrite', 'gather', 'context', 'claim', 'done']);
  });
});
