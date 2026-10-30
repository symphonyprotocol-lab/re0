/**
 * The playground's agent mode, as decisions. playground-agent-proposal.md,
 * architecture.md 9.5: the planner only chooses what to read; only reads the
 * confirmation gate accepts become evidence; the answering call sees the
 * evidence and the question -- never the earlier turns -- and binds every
 * sentence as before; one exchange is one Call whatever it read; and when the
 * agent cannot run, or finds nothing to stand on after failing, the fixed
 * path answers instead.
 *
 * Everything below the playground is faked through its dependency seams, so
 * this runs without a database or a provider.
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '@/contracts/errors';
import type { ResolveLibraryOutput } from '@/contracts/schemas';
import type { ReservedCall } from '@/lib/application/plans';
import type { GatherResult } from '@/lib/application/retrieval/gather';
import type { QueryDocsResult } from '@/lib/application/retrieval/query-docs';
import {
  streamAgentPlayground,
  type AgentDependencies,
  type AgentEvent,
  type AgentInput,
} from '@/lib/application/playground/agent';
import { PLANNER_SYSTEM_PROMPT, PLAYGROUND_SYSTEM_PROMPT, type HistoryTurn } from '@/lib/domain/generation';
import { DEFAULT_RETRIEVAL_SETTINGS } from '@/lib/domain/retrieval-config';
import type { PlanEvent, PlannerTool } from '@/lib/infrastructure/ai/llm';

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
  supportsTools: true,
  supportsReasoning: false,
  supportsVision: false,
  reasoningEffort: null,
  enabled: true,
  createdAt: new Date(),
  assignedTo: ['trial' as const],
};

const EDIT2 = { libraryId: '/websites/edit2', title: 'edit2' };
const OTHER = { libraryId: '/websites/other', title: 'Other' };
const caller = { workspaceId: 'ws_1', apiKeyId: null, requestId: 'req_1', anonymous: false };

const HISTORY: HistoryTurn[] = [
  {
    question: 'What is edit2?',
    answer: 'edit2 is a fast editor for text files.',
    libraries: [EDIT2],
  },
];

/** One read's result, confirmed or not; the first read of an exchange holds the seat. */
function result(libraryId: string, confirmed: boolean, chunkIds: string[], reservation: ReservedCall | null) {
  return {
    libraryId,
    version: 'v1',
    chunks: chunkIds.map((id, rank) => ({
      chunkId: id,
      text: `Passage ${id}: download edit2 from the releases page.`,
      score: 1 / (60 + rank),
      tokens: 12,
      citation: { sourceUrl: `https://edit2.test/${id}`, documentTitle: 'Install', section: null, lines: null },
    })),
    usage: { callsUsed: 1, planAllowanceRemaining: 10, addonBalanceRemaining: 0 },
    requestId: caller.requestId,
    confidence: confirmed ? { bestDistance: 0.2, keywordHits: 3 } : { bestDistance: 0.9, keywordHits: 0 },
    served: { libraryId, versionId: `ver_${libraryId}`, returnedTokens: 12, latencyMs: 5 },
    reservation,
  } as unknown as QueryDocsResult;
}

type Script = { tool: string; input: unknown }[];

interface Fixture {
  /** The tool calls the planner makes, in order; it stops at `answer` or the step cap. */
  script: Script;
  /** Throws after this many calls, as a provider that dies mid-plan. */
  failAfter?: number;
  /** Per library: confirmed or not, and the chunk ids it returns. */
  reads?: Record<string, { confirmed: boolean; chunks: string[] } | AppError>;
  /** Per query, ahead of `reads`. */
  byQuery?: Record<string, { confirmed: boolean; chunks: string[] }>;
  /** What the answering call replies. */
  answer?: string;
  agent?: 0 | 1;
  supportsTools?: boolean;
  pinned?: AgentInput['pinned'];
  history?: HistoryTurn[];
}

function fixture(options: Fixture) {
  const calls = {
    reads: [] as { libraryId: string; query: string; meter: unknown }[],
    resolves: [] as string[],
    commits: [] as string[],
    releases: [] as string[],
    llm: [] as { system: string; user: string }[],
    tools: [] as string[][],
    gathers: 0,
  };
  const SEAT = { reservationId: 'seat_1' } as ReservedCall;

  async function* scripted(input: { tools: PlannerTool[]; maxSteps: number }): AsyncGenerator<PlanEvent> {
    calls.tools.push(input.tools.map((tool) => tool.name));
    let step = 0;
    for (const entry of options.script) {
      if (options.failAfter !== undefined && step === options.failAfter) throw new Error('provider down');
      if (step >= input.maxSteps) break;
      step += 1;
      const tool = input.tools.find((candidate) => candidate.name === entry.tool);
      const id = `call_${step}`;
      yield { type: 'call', id, tool: entry.tool, input: entry.input };
      if (!tool) {
        yield { type: 'result', id, tool: entry.tool, output: { error: 'invalid_input' } };
        continue;
      }
      const output = await tool.execute(tool.input.parse(entry.input));
      yield { type: 'result', id, tool: entry.tool, output };
      /* As the adapter's stop condition: `done: false` is "not yet". */
      if (entry.tool === 'answer' && (output as { done?: unknown }).done !== false) break;
    }
  }

  const dependencies: AgentDependencies = {
    config: async () => ({ ...CONFIG, supportsTools: options.supportsTools ?? true }),
    audience: async () => 'trial',
    credential: async () => 'sk-fixture',
    recordCost: async () => {},
    retrieval: {
      embeddings: () => {
        throw new Error('not used');
      },
      rerank: () => {
        throw new Error('not used');
      },
      cache: () => ({ get: async () => null, set: async () => {}, invalidateTag: async () => {} }),
      configured: () => ({ embeddings: false, rerank: false }),
      settings: async () => ({
        ...DEFAULT_RETRIEVAL_SETTINGS,
        playgroundAgent: options.agent ?? 1,
        configId: null,
        createdAt: null,
      }),
    },
    resolve: async (_caller, input) => {
      calls.resolves.push(input.query);
      return {
        results: [EDIT2, OTHER].map((library) => ({
          ...library,
          description: null,
          version: 'v1',
          versions: ['v1'],
          trustScore: 80,
          benchmarkScore: 80,
          chunks: 10,
          updatedAt: new Date().toISOString(),
          evidence: { matchedTitles: ['Install'], matchedTerms: ['download'] },
        })),
        requestId: caller.requestId,
      } as ResolveLibraryOutput;
    },
    read: async (_caller, input, _dependencies, readOptions) => {
      calls.reads.push({ libraryId: input.libraryId, query: input.query, meter: readOptions.meter });
      const planned = options.byQuery?.[input.query] ??
        options.reads?.[input.libraryId] ?? { confirmed: true, chunks: ['c1'] };
      if (planned instanceof AppError) throw planned;
      return result(
        input.libraryId,
        planned.confirmed,
        planned.chunks,
        readOptions.meter === 'deferred' ? SEAT : null,
      );
    },
    commit: async (_caller, seat, served) => {
      calls.commits.push(`${seat.reservationId}:${served.libraryId}`);
    },
    release: async (reservationId) => {
      calls.releases.push(reservationId);
    },
    /* The fixed path's scatter-gather, for the fallbacks. */
    gather: async () => {
      calls.gathers += 1;
      return {
        chunks: [],
        libraries: [{ ...EDIT2, version: 'v1', confirmed: false, faqNearest: null, chunks: 0, failed: false, excerpts: [] }],
        requestId: caller.requestId,
      } satisfies GatherResult;
    },
    hints: async () => [],
    llm: () => ({
      stream(input) {
        calls.llm.push({ system: input.systemPrompt, user: input.userMessage });
        const reply =
          input.systemPrompt === PLAYGROUND_SYSTEM_PROMPT
            ? (options.answer ?? 'Download edit2 from the releases page. [ref:1]')
            : 'where to download edit2';
        return {
          textStream: (async function* deltas() {
            for (const piece of reply.match(/[\s\S]{1,7}/g) ?? []) yield piece;
          })(),
          usage: Promise.resolve({ promptTokens: 100, completionTokens: 20, cachedTokens: 0, reasoningTokens: 0 }),
        };
      },
      plan(input) {
        calls.llm.push({ system: input.systemPrompt, user: input.userMessage });
        return {
          events: scripted(input),
          usage: Promise.resolve({ promptTokens: 300, completionTokens: 30, cachedTokens: 0, reasoningTokens: 0 }),
        };
      },
    }),
  };
  return { dependencies, calls };
}

async function run(options: Fixture, question = 'Where do I download it?') {
  const { dependencies, calls } = fixture(options);
  const events: AgentEvent[] = [];
  for await (const event of streamAgentPlayground(
    caller,
    { question, history: options.history ?? HISTORY, pinned: options.pinned ?? null },
    dependencies,
  )) {
    events.push(event);
  }
  return { events, calls };
}

const outcome = (events: AgentEvent[]) =>
  events.flatMap((event) => (event.type === 'done' ? [event.kind] : event.type === 'no_library' ? ['no_library'] : []));
const claims = (events: AgentEvent[]) =>
  events.flatMap((event) => (event.type === 'claim' ? [event] : []));

describe('playground agent', () => {
  it('answers a follow-up from the library the turns name, with the turns kept from the answer', async () => {
    const { events, calls } = await run({
      script: [
        { tool: 'query_docs', input: { libraryId: EDIT2.libraryId, query: 'download edit2' } },
        { tool: 'answer', input: { question: 'Where do I download edit2?' } },
      ],
    });

    expect(outcome(events)).toEqual(['answer']);
    expect(claims(events)).toEqual([
      { type: 'claim', claim: 'Download edit2 from the releases page.', chunkIds: ['c1'] },
    ]);
    expect(events.filter((event) => event.type === 'step').map((event) => event.type === 'step' && event.step.status)).toEqual([
      'running',
      'done',
    ]);
    expect(events).toContainEqual({ type: 'resolved', question: 'Where do I download edit2?' });

    const planner = calls.llm.find((call) => call.system === PLANNER_SYSTEM_PROMPT)!;
    expect(planner.user).toContain('edit2 is a fast editor for text files.');
    expect(planner.user).toContain(EDIT2.libraryId);
    const answering = calls.llm.find((call) => call.system === PLAYGROUND_SYSTEM_PROMPT)!;
    expect(answering.user).toContain('Question: Where do I download it?');
    expect(answering.user).toContain('Where do I download edit2?');
    expect(answering.user).not.toContain('fast editor');

    expect(calls.reads).toEqual([{ libraryId: EDIT2.libraryId, query: 'download edit2', meter: 'deferred' }]);
    expect(calls.commits).toEqual([`seat_1:${EDIT2.libraryId}`]);
    expect(calls.releases).toEqual([]);
  });

  it('never cites a read that did not confirm', async () => {
    const { events, calls } = await run({
      script: [
        { tool: 'query_docs', input: { libraryId: OTHER.libraryId, query: 'download' } },
        { tool: 'query_docs', input: { libraryId: EDIT2.libraryId, query: 'download edit2' } },
        { tool: 'answer', input: { question: 'Where do I download edit2?' } },
      ],
      reads: { [OTHER.libraryId]: { confirmed: false, chunks: ['c9'] } },
      answer: 'Download edit2 from the releases page. [ref:1] It is also on a mirror. [ref:2]',
    });

    const context = events.find((event) => event.type === 'context');
    expect(context?.type === 'context' && context.chunks.map((chunk) => chunk.chunkId)).toEqual(['c1']);
    expect(claims(events).map((claim) => claim.chunkIds)).toEqual([['c1']]);
    /* One seat, reserved by the first read, committed to the library that served. */
    expect(calls.reads.map((read) => read.meter)).toEqual(['deferred', false]);
    expect(calls.commits).toEqual([`seat_1:${EDIT2.libraryId}`]);
  });

  it('holds the planner to the console caps', async () => {
    const queries = Array.from({ length: 5 }, (_, at) => ({
      tool: 'query_docs',
      input: { libraryId: EDIT2.libraryId, query: `query ${at}` },
    }));
    const { calls } = await run({ script: [...queries, { tool: 'answer', input: { question: 'x' } }] });
    /* 4 steps by default: 3 reads would fit, and the fourth step is the cap's. */
    expect(calls.reads.length).toBeLessThanOrEqual(DEFAULT_RETRIEVAL_SETTINGS.playgroundAgentQueries);
  });

  it('reads the same library and query once', async () => {
    const same = { tool: 'query_docs', input: { libraryId: EDIT2.libraryId, query: 'download edit2' } };
    const { calls } = await run({ script: [same, same, { tool: 'answer', input: { question: 'x' } }] });
    expect(calls.reads).toHaveLength(1);
  });

  it('hands a plan that confirmed nothing to the fixed path, with its seat released', async () => {
    const { events, calls } = await run({
      script: [
        { tool: 'query_docs', input: { libraryId: EDIT2.libraryId, query: 'download edit2' } },
        { tool: 'answer', input: { question: 'x' } },
        { tool: 'answer', input: { question: 'x' } },
      ],
      reads: { [EDIT2.libraryId]: { confirmed: false, chunks: ['c9'] } },
    });
    expect(events.some((event) => event.type === 'routing')).toBe(true);
    expect(calls.gathers).toBeGreaterThan(0);
    /* The fake's fixed path confirms nothing either: still no answering call. */
    expect(outcome(events)).toEqual(['no_context']);
    expect(calls.llm.some((call) => call.system === PLAYGROUND_SYSTEM_PROMPT)).toBe(false);
    expect(calls.releases).toEqual(['seat_1']);
    expect(calls.commits).toEqual([]);
  });

  it('turns down an answer once while nothing has confirmed and reads remain', async () => {
    const { events, calls } = await run({
      script: [
        { tool: 'query_docs', input: { libraryId: EDIT2.libraryId, query: '下载地址 安装' } },
        { tool: 'answer', input: { question: 'x' } },
        { tool: 'query_docs', input: { libraryId: EDIT2.libraryId, query: 'Where do I download edit2?' } },
        { tool: 'answer', input: { question: 'Where do I download edit2?' } },
      ],
      byQuery: { '下载地址 安装': { confirmed: false, chunks: ['c9'] } },
      answer: 'Download edit2 from the releases page. [ref:1]',
    });
    expect(calls.reads.map((read) => read.query)).toEqual(['下载地址 安装', 'Where do I download edit2?']);
    expect(outcome(events)).toEqual(['answer']);
  });

  it('tells the planner which language a library is written in', async () => {
    const { dependencies } = fixture({ script: [] });
    let shown: unknown = null;
    dependencies.llm = (config) => {
      const base = fixture({ script: [] }).dependencies.llm(config);
      return {
        ...base,
        plan(input) {
          const tool = input.tools.find((candidate) => candidate.name === 'query_docs')!;
          return {
            events: (async function* () {
              shown = await tool.execute({ libraryId: EDIT2.libraryId, query: '下载' });
            })(),
            usage: Promise.resolve({ promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0 }),
          };
        },
      };
    };
    for await (const _event of streamAgentPlayground(caller, { question: 'q', history: HISTORY, pinned: null }, dependencies)) {
      /* drain */
    }
    expect(shown).toMatchObject({ language: 'English' });
  });

  it('offers no resolve tool on a fixed library, and refuses reads of any other', async () => {
    const { calls } = await run({
      pinned: { ...EDIT2, version: 'v1' },
      script: [
        { tool: 'query_docs', input: { libraryId: OTHER.libraryId, query: 'download' } },
        { tool: 'query_docs', input: { libraryId: EDIT2.libraryId, query: 'download' } },
        { tool: 'answer', input: { question: 'x' } },
      ],
    });
    expect(calls.tools[0]).toEqual(['query_docs', 'answer']);
    expect(calls.reads.map((read) => read.libraryId)).toEqual([EDIT2.libraryId]);
  });

  it('ends the exchange on a quota refusal, holding no seat', async () => {
    await expect(
      run({
        script: [{ tool: 'query_docs', input: { libraryId: EDIT2.libraryId, query: 'download' } }],
        reads: { [EDIT2.libraryId]: new AppError('quota_exceeded', 'no calls left') },
      }),
    ).rejects.toMatchObject({ code: 'quota_exceeded' });
  });

  it('shows the planner a refused library and lets it carry on', async () => {
    const { events, calls } = await run({
      script: [
        { tool: 'query_docs', input: { libraryId: OTHER.libraryId, query: 'download' } },
        { tool: 'query_docs', input: { libraryId: EDIT2.libraryId, query: 'download edit2' } },
        { tool: 'answer', input: { question: 'x' } },
      ],
      reads: { [OTHER.libraryId]: new AppError('library_not_found', 'gone') },
    });
    expect(outcome(events)).toEqual(['answer']);
    const refused = events.find((event) => event.type === 'step' && event.step.error !== null);
    expect(refused?.type === 'step' && refused.step.error).toBe('library_not_found');
    /* The refused read reserved nothing, so the next one holds the seat. */
    expect(calls.reads.map((read) => read.meter)).toEqual(['deferred', 'deferred']);
  });

  it('falls back to the fixed path when the planner dies before finding anything', async () => {
    const { events, calls } = await run({
      script: [{ tool: 'query_docs', input: { libraryId: EDIT2.libraryId, query: 'download' } }],
      failAfter: 0,
    });
    expect(events.some((event) => event.type === 'routing')).toBe(true);
    expect(calls.gathers).toBeGreaterThan(0);
  });

  it('runs the fixed path when the switch is off or the model cannot call tools', async () => {
    for (const options of [{ agent: 0 as const }, { supportsTools: false }]) {
      const { events, calls } = await run({ script: [], ...options });
      expect(calls.llm.some((call) => call.system === PLANNER_SYSTEM_PROMPT)).toBe(false);
      const routing = events.find((event) => event.type === 'routing');
      /* "Where do I download it?" routes to the fake's candidates here; the follow-up fallback is routeQuestion's. */
      expect(routing).toBeDefined();
    }
  });
});

describe('fixed-path routing', () => {
  it('reads the libraries the last turn answered from when a follow-up routes nowhere', async () => {
    const { routeQuestion } = await import('@/lib/application/playground');
    const nothing = async () => ({ results: [], requestId: caller.requestId }) as ResolveLibraryOutput;

    const followUp = await routeQuestion(caller, 'Where do I download it?', HISTORY, nothing);
    expect(followUp).toEqual({
      candidates: [EDIT2],
      top: { ...EDIT2, version: null },
      followUp: true,
    });

    const alone = await routeQuestion(caller, 'Where do I download it?', [], nothing);
    expect(alone.top).toBeNull();
  });
});
