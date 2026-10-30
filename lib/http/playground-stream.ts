import type { UIMessage } from 'ai';
import type { CodeBlock } from '@/lib/domain/code-blocks';
import type { ActionState, ActionSummary, ActionTool } from '@/lib/domain/agent-action';
import type { DelegationView } from '@/lib/application/external-agents/delegation';

/**
 * The shape of the playground's UI message stream, shared by the route that
 * writes it and the transcript that reads it.
 *
 * A BFF contract, deliberately not in `contracts/`: architecture.md 9.5 keeps
 * generation out of /v1, and only this one page consumes these parts.
 *
 * There is no text part in the union, and that is the point. Model prose never
 * reaches the client as prose -- it arrives as `claim` parts the server has
 * already bound to a chunk of the same request (requirement.md 5.1 rule 5), so
 * nothing can be rendered as fact before it is citable.
 */

export interface PlaygroundSource {
  chunkId: string;
  sourceUrl: string;
  documentTitle: string;
  section: string | null;
  /** Which asset the passage came from: the answer may draw on several. */
  assetId: string;
  assetTitle: string;
  /** The passage's fenced code, as data (requirement.md 5.1: 代码示例). */
  codeBlocks: CodeBlock[];
}

/** What the scatter-gather read, per routed candidate (retrieval/gather.ts). */
export interface PlaygroundGather {
  assets: {
    assetId: string;
    title: string;
    version: string | null;
    /** Its passages fit the question; it contributes to the answer. */
    confirmed: boolean;
    chunks: number;
    failed: boolean;
  }[];
}

export interface PlaygroundRouting {
  question: string;
  /** What resolve-asset-id returned; every one of them is read. */
  candidates: { assetId: string; title: string }[];
  /** The top candidate: the one the exchange is metered on. */
  assetId: string | null;
  assetTitle: string | null;
  version: string | null;
  requestId: string;
  /**
   * The caller named the asset (the detail page's fixed entry), so no
   * resolve-asset-id ran: the transcript shows one query-docs only.
   */
  pinned: boolean;
}

/** Which configured model is answering, and whether a paid plan would offer another. */
export interface PlaygroundModel {
  label: string;
  audience: 'trial' | 'subscriber';
  /** For a trial caller: the subscriber model a paid plan would answer with, if one is configured. */
  upgrade: string | null;
}

/** `acted`: a workbench exchange that listed or proposed, with nothing to answer from. */
export type PlaygroundOutcome = 'answer' | 'degraded' | 'no_context' | 'no_asset' | 'acted';

/**
 * A pending action as its confirmation card needs it (workbench only,
 * agent-first-proposal.md 5.2): the server's summary, and the digest a
 * confirmation must name.
 */
export interface WorkbenchAction {
  id: string;
  tool: ActionTool;
  state: ActionState;
  summary: ActionSummary;
  digest: string;
  expiresAt: string;
  error: string | null;
  /** For a confirmed `delegate_task`: the remote task it started (proposal 7.9). */
  delegation?: DelegationView | null;
}

/** What a workbench read tool found (playground/agent.ts `WorkbenchListing`). */
export type WorkbenchListingPart =
  | {
      kind: 'assets';
      total: number;
      assets: { id: string; publicId: string; title: string; kind: string; channel: string | null; status: string; building: boolean }[];
    }
  | {
      kind: 'subscriptions';
      channels: { slug: string; title: string; visibility: string; assets: number }[];
      usedBytes: number;
      capacityBytes: number;
    }
  | {
      /** What external Agents returned (`check_delegation`): their output, as data. */
      kind: 'delegations';
      delegations: DelegationView[];
    };

/**
 * One tool call the planner made (agent mode, playground/agent.ts), written
 * twice under the call's id: running, then done with what it found. The
 * transcript is the real call sequence, as it is on the fixed path.
 */
export interface PlaygroundStep {
  id: string;
  tool: 'resolve-asset-id' | 'query-docs';
  query: string;
  assetId: string | null;
  status: 'running' | 'done';
  results: string[] | null;
  confirmed: boolean | null;
  version: string | null;
  error: string | null;
}

export type PlaygroundUIMessage = UIMessage<
  never,
  {
    routing: PlaygroundRouting;
    gather: PlaygroundGather;
    model: PlaygroundModel;
    /**
     * The first retrieval missed and a retry with this query confirmed; the
     * `gather` and `sources` after it are the retry's (playground/index.ts).
     */
    rewrite: { query: string };
    step: PlaygroundStep;
    /** The planner's restatement of a follow-up; the answer was asked it alongside the question. */
    resolved: { question: string };
    sources: { sources: PlaygroundSource[] };
    /** One bound sentence. `chunkIds` are its footnotes, in citation order. */
    claim: { claim: string; chunkIds: string[] };
    outcome: { kind: PlaygroundOutcome };
    /** Workbench: a proposal waiting for the owner's confirmation card. */
    action: WorkbenchAction;
    /** Workbench: a proposal the gate refused before any row was written. */
    refused: { tool: ActionTool; code: string; message: string };
    /** Workbench: a listing the server wrote. */
    listing: WorkbenchListingPart;
    /** Workbench: the conversation this exchange was recorded in. */
    conversation: { id: string };
  }
>;
